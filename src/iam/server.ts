import { fileURLToPath } from "node:url";
import { OperationError, type ActionKind, type ResourceCheck } from "../contract.js";
import type { Caller } from "../client.js";
import { defineServerModule } from "../server/index.js";
import { iamContract } from "./contract.js";
import { MANAGED_POLICIES, STARTER_ROLES, evaluate, isDenied, statementProblems, type ActionMeta, type PolicyDocument, type PolicyStatement } from "./policy.js";
import { iamPolicy, iamRole, iamRolePolicy, iamRoot, iamUserRole } from "./schema.js";

export interface IamAccount {
  id: number;
  email: string;
  displayName: string;
  disabled?: boolean;
  /** Has a way to log in. Default true. */
  login?: boolean;
  /** Has a second factor; leave out where not tracked. */
  mfa?: boolean;
  invite?: { state: "pending" | "expired" | "accepted" | "revoked"; expiresAt: string } | null;
}

type InviteResult = { token: string; expiresAt: Date } | { error: "not-found" | "accepted" } | { error: "idp"; message: string };

/**
 * Where accounts live - IAM only attaches roles to them. With vault-service:
 * `createAccountStore(db)`. Leave out `create` where accounts come from
 * elsewhere (OIDC): the admin UI then can't create them.
 */
export interface IamAccounts {
  list(): IamAccount[] | Promise<IamAccount[]>;
  create?(input: { email: string; password: string; displayName: string }): Promise<{ id: number } | { error: "email-taken" }>;
  disable?(userId: number): Promise<void>;
  enable?(userId: number): Promise<void>;
  revokeSessions?(userId: number): Promise<void>;
  resetPassword?(userId: number, password: string): Promise<{ ok: true } | { error: "no-local-login" }>;
  /** An account with no login yet, plus a one-time invite token (vault-service's `accounts.invite`). */
  invite?(input: { email: string; displayName: string }): Promise<{ id: number; token: string; expiresAt: Date } | { error: "email-taken" } | { error: "idp"; message: string }>;
  /** A fresh token for an invite not yet accepted; earlier ones stop working. */
  reinvite?(userId: number): Promise<InviteResult>;
  revokeInvite?(userId: number): Promise<void>;
  /** Removes every second factor; they set one up again at their next login. */
  resetMfa?(userId: number): Promise<void>;
}

/** What `invites.send` gets: everything for the email, including the one-time link. */
export interface IamInviteMail {
  userId: number;
  email: string;
  displayName: string;
  link: string;
  expiresAt: string;
  /** A resend rather than the first invite. */
  again: boolean;
}

/** What vault-service's `onLogin` hands over (see `createAuthRoutes`). */
export interface IamLoginEvent {
  userId: number;
  /** This login created the account (open signup, first OIDC login). */
  created: boolean;
  provider: string;
  /** The IdP's ID token claims, for OIDC logins. */
  claims?: Record<string, unknown>;
}

export interface IamOptions {
  accounts: IamAccounts;
  /** The root account. Default: the first account (lowest id), fixed the first time IAM sees one. */
  rootEmail?: string;
  /** Roles given to accounts created by signing up (not by an admin, who picks roles). */
  defaultRoles?: readonly string[];
  /**
   * The app's own managed policies, next to AdministratorAccess and
   * ReadOnlyAccess: kept matching this code on every boot, and not
   * editable or deletable in the UI. Names can't reuse a built-in one.
   */
  policies?: Readonly<Record<string, { description: string; document: PolicyDocument }>>;
  /**
   * Roles created on a fresh install, instead of the built-in `admin` and
   * `member`. Ordinary data afterwards, like those. Their policies must be
   * managed ones (built-in or `policies`).
   */
  starterRoles?: Readonly<Record<string, { description: string; policies: readonly string[] }>>;
  /**
   * OIDC: IdP role -> IAM role, applied at every login (replacing the
   * previous login's). `rolesFromClaims` reads the IdP roles; the default
   * understands Zitadel's `urn:zitadel:iam:org:project[:<id>]:roles` claim.
   */
  oidc?: { roleMap: Readonly<Record<string, string>>; rolesFromClaims?: (claims: Record<string, unknown>) => string[] };
  /**
   * Inviting needs `accounts.invite` and these. `link` turns a token into the
   * page the person opens (build it from configuration, never a request).
   * `send` emails it, as the admin who invited; without it, or when it
   * throws, the admin is shown the link to pass on.
   */
  invites?: { link(token: string): string; send?(call: Caller, mail: IamInviteMail): Promise<void> };
  logError?: (error: unknown, message: string) => void;
}

interface Raw {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
}

const ALWAYS_ALLOWED = new Set(["iam:myAccess"]);

/** Zitadel puts project roles in `urn:zitadel:iam:org:project[:<projectId>]:roles` as `{ role: {...orgs} }`. */
export function zitadelRoles(claims: Record<string, unknown>): string[] {
  const roles = new Set<string>();
  for (const [key, value] of Object.entries(claims)) {
    if (/^urn:zitadel:iam:org:project(:\d+)?:roles$/.test(key) && value && typeof value === "object") {
      for (const role of Object.keys(value)) roles.add(role);
    }
  }
  return [...roles];
}

/**
 * The built-in IAM module. Install `module` in the host, pass `authorize`
 * as the host's `authorize`, and `onLogin` to vault-service's
 * `createAuthRoutes` (for OIDC role mapping and signup default roles).
 *
 * Users get roles, roles get policies, policies allow or deny actions -
 * see ./policy.ts. Root is allowed everything.
 */
export function createIam(options: IamOptions) {
  for (const name of Object.keys(options.policies ?? {})) {
    if (name in MANAGED_POLICIES) throw new Error(`IAM: policy "${name}" is built in and can't be redefined`);
  }
  const managedPolicies = { ...MANAGED_POLICIES, ...options.policies };
  const starterRoles = options.starterRoles ?? STARTER_ROLES;
  for (const [role, { policies }] of Object.entries(starterRoles)) {
    for (const policy of policies) {
      if (!(policy in managedPolicies)) throw new Error(`IAM: starter role "${role}" uses "${policy}", which isn't a managed policy`);
    }
  }
  let raw: Raw | undefined;
  let actionInfo: Map<string, ActionMeta> | undefined;
  let listActions: () => readonly { action: string; kind: ActionKind; resource?: string }[] = () => [];
  let seeded = false;
  let rootId: number | undefined;
  const statementsByUser = new Map<number, PolicyStatement[]>();

  const db = () => {
    if (!raw) throw new Error("IAM: the module isn't installed in a server host");
    return raw;
  };
  const infoOf = (action: string) => (actionInfo ??= new Map(listActions().map((a) => [a.action, { kind: a.kind, resource: a.resource }]))).get(action);
  const changed = () => statementsByUser.clear();

  /** Managed policies always match this code; starter roles only appear on a fresh install. */
  const seed = () => {
    if (seeded) return;
    const sql = db();
    sql.transaction(() => {
      const fresh = !sql.prepare("SELECT 1 FROM iam_root").get() && !sql.prepare("SELECT 1 FROM iam_role").get();
      for (const [name, policy] of Object.entries(managedPolicies)) {
        sql
          .prepare(
            `INSERT INTO iam_policy (name, description, document, managed) VALUES (?, ?, ?, 1)
             ON CONFLICT (name) DO UPDATE SET description = excluded.description, document = excluded.document, managed = 1`,
          )
          .run(name, policy.description, JSON.stringify(policy.document));
      }
      if (fresh) {
        for (const [name, role] of Object.entries(starterRoles)) {
          sql.prepare("INSERT INTO iam_role (name, description) VALUES (?, ?)").run(name, role.description);
          for (const policy of role.policies) sql.prepare("INSERT INTO iam_role_policy (role, policy) VALUES (?, ?)").run(name, policy);
        }
      }
    })();
    seeded = true;
  };

  const root = (): number | undefined => {
    if (rootId !== undefined) return rootId;
    const sql = db();
    const row = sql.prepare("SELECT user_id AS id FROM iam_root").get() as { id: number } | undefined;
    if (row) return (rootId = row.id);
    const candidate = (
      options.rootEmail
        ? sql.prepare("SELECT id FROM user WHERE email = ?").get(options.rootEmail)
        : sql.prepare("SELECT id FROM user ORDER BY id LIMIT 1").get()
    ) as { id: number } | undefined;
    if (!candidate) return undefined;
    sql.prepare("INSERT OR IGNORE INTO iam_root (user_id) VALUES (?)").run(candidate.id);
    return (rootId = candidate.id);
  };

  const statementsFor = (userId: number): PolicyStatement[] => {
    let statements = statementsByUser.get(userId);
    if (!statements) {
      const rows = db()
        .prepare(
          `SELECT DISTINCT p.name, p.document FROM iam_user_role ur
           JOIN iam_role_policy rp ON rp.role = ur.role
           JOIN iam_policy p ON p.name = rp.policy
           WHERE ur.user_id = ?`,
        )
        .all(userId) as { document: string }[];
      statements = rows.flatMap((r) => (JSON.parse(r.document) as PolicyDocument).statements);
      statementsByUser.set(userId, statements);
    }
    return statements;
  };

  const selfServiceActions = () => listActions().filter((a) => a.kind === "self-service").map((a) => a.action);
  const allowedFor = (userId: number, action: string, resource?: ResourceCheck): boolean => {
    if (ALWAYS_ALLOWED.has(action)) return true;
    seed();
    if (userId === root()) return true;
    const request = { userId, resource };
    if (infoOf(action)?.kind === "self-service") return !isDenied(statementsFor(userId), action, infoOf, request);
    return evaluate(statementsFor(userId), action, infoOf, request);
  };
  /** Admin actions on someone else's account: never root, and (for disabling) not yourself. */
  const assertTarget = (callerId: number, userId: number, what: string, notSelf = false) => {
    if (userId === root()) throw new OperationError(400, `root can't be ${what}`);
    if (notSelf && userId === callerId) throw new OperationError(400, `you can't ${what.replace(/d$/, "")} yourself`);
  };
  const need = <K extends "disable" | "enable" | "revokeSessions" | "resetPassword" | "reinvite" | "revokeInvite" | "resetMfa">(key: K) => {
    const fn = options.accounts[key];
    if (!fn) throw new OperationError(400, "not supported for these accounts");
    return fn.bind(options.accounts) as NonNullable<IamAccounts[K]>;
  };

  const canInvite = () => options.accounts.invite !== undefined && options.invites !== undefined;
  const logError = options.logError ?? ((error, message) => console.error(message, error));
  /** Emails the link when the app can; otherwise hands it to the admin. */
  const deliver = async (call: Caller, account: { userId: number; email: string; displayName: string }, token: string, expiresAt: Date, again: boolean) => {
    const link = options.invites!.link(token);
    const mail = { ...account, link, expiresAt: expiresAt.toISOString(), again };
    if (options.invites!.send) {
      try {
        await options.invites!.send(call, mail);
        return { link: null, expiresAt: mail.expiresAt, emailed: true };
      } catch (error) {
        logError(error, "iam: sending an invite failed");
      }
    }
    return { link, expiresAt: mail.expiresAt, emailed: false };
  };

  const roleNames = () => new Set((db().prepare("SELECT name FROM iam_role").all() as { name: string }[]).map((r) => r.name));
  const assertRolesExist = (roles: readonly string[]) => {
    const known = roleNames();
    const unknown = roles.filter((r) => !known.has(r));
    if (unknown.length > 0) throw new OperationError(400, `unknown role: ${unknown.join(", ")}`);
  };
  const replaceRoles = (userId: number, source: "manual" | "oidc", roles: readonly string[]) => {
    const sql = db();
    sql.transaction(() => {
      sql.prepare("DELETE FROM iam_user_role WHERE user_id = ? AND source = ?").run(userId, source);
      for (const role of new Set(roles)) sql.prepare("INSERT INTO iam_user_role (user_id, role, source) VALUES (?, ?, ?)").run(userId, role, source);
    })();
    changed();
  };

  const module = defineServerModule({
    contract: iamContract,
    schema: { iamPolicy, iamRole, iamRolePolicy, iamUserRole, iamRoot },
    migrationsFolder: fileURLToPath(new URL("../../migrations/iam", import.meta.url)),
    implement: (ctx) => {
      // Raw SQL rather than ctx.db's query builder: the app's drizzle copy and
      // ours may differ (linked repos), and these queries are simple.
      raw = (ctx.db as unknown as { $client: Raw }).$client;
      listActions = ctx.actions;
      // GDPR: a person's roles are data about them. Root is the install's owner and is never erased.
      ctx.privacy.handle("user", {
        export: (_call, userId) => ({
          root: userId === root(),
          roles: db().prepare("SELECT role, source FROM iam_user_role WHERE user_id = ? ORDER BY role").all(userId) as { role: string; source: string }[],
        }),
        erase: (_call, userId) => {
          if (userId === root()) throw new OperationError(400, "root can't be erased");
          const removed = (db().prepare("DELETE FROM iam_user_role WHERE user_id = ?").run(userId) as { changes: number }).changes;
          changed();
          return { removed };
        },
      });
      return {
        queries: {
          myAccess: (call) => {
            seed();
            return {
              userId: call.userId,
              root: call.userId === root(),
              statements: statementsFor(call.userId),
              selfService: selfServiceActions().map((action) => ({ action, allowed: allowedFor(call.userId, action) })),
            };
          },
          users: async () => {
            seed();
            const rootUser = root();
            const rows = db().prepare("SELECT user_id AS userId, role, source FROM iam_user_role ORDER BY role").all() as {
              userId: number;
              role: string;
              source: "manual" | "oidc";
            }[];
            const accounts = await options.accounts.list();
            return accounts.map((a) => ({
              id: a.id,
              email: a.email,
              displayName: a.displayName,
              disabled: a.disabled ?? false,
              login: a.login ?? true,
              mfa: a.mfa ?? null,
              invite: a.invite ?? null,
              root: a.id === rootUser,
              roles: rows.filter((r) => r.userId === a.id).map((r) => ({ name: r.role, source: r.source })),
            }));
          },
          roles: () => {
            seed();
            const links = db().prepare("SELECT role, policy FROM iam_role_policy ORDER BY policy").all() as { role: string; policy: string }[];
            return (db().prepare("SELECT name, description FROM iam_role ORDER BY name").all() as { name: string; description: string }[]).map((r) => ({
              ...r,
              policies: links.filter((l) => l.role === r.name).map((l) => l.policy),
            }));
          },
          policies: () => {
            seed();
            return (
              db().prepare("SELECT name, description, document, managed FROM iam_policy ORDER BY managed DESC, name").all() as {
                name: string;
                description: string;
                document: string;
                managed: number;
              }[]
            ).map((p) => ({ name: p.name, description: p.description, managed: p.managed === 1, document: JSON.parse(p.document) }));
          },
          actions: () => [...ctx.actions()].sort((a, b) => a.action.localeCompare(b.action)),
          resources: () => [...ctx.resources()].map((r) => ({ ...r, attributes: [...r.attributes] })).sort((a, b) => a.type.localeCompare(b.type)),
          settings: () => ({
            canCreateUsers: options.accounts.create !== undefined,
            canDisableUsers: options.accounts.disable !== undefined && options.accounts.enable !== undefined,
            canResetPasswords: options.accounts.resetPassword !== undefined,
            canRevokeSessions: options.accounts.revokeSessions !== undefined,
            canInvite: canInvite(),
            emailsInvites: canInvite() && options.invites?.send !== undefined,
            canResetMfa: options.accounts.resetMfa !== undefined,
          }),
        },
        commands: {
          createUser: async (call, input) => {
            seed();
            assertRolesExist(input.roles);
            const displayName = input.displayName?.trim() || input.email;
            if (input.password === undefined) {
              if (!canInvite()) throw new OperationError(400, "invites aren't set up here");
              const result = await options.accounts.invite!({ email: input.email, displayName });
              if ("error" in result) {
                if (result.error === "idp") throw new OperationError(502, `the identity provider refused: ${result.message}`);
                throw new OperationError(409, "an account with that email already exists");
              }
              replaceRoles(result.id, "manual", input.roles);
              return { id: result.id, invite: await deliver(call, { userId: result.id, email: input.email, displayName }, result.token, result.expiresAt, false) };
            }
            if (!options.accounts.create) throw new OperationError(400, "accounts with a password can't be created here");
            const result = await options.accounts.create({ email: input.email, password: input.password, displayName });
            if ("error" in result) throw new OperationError(409, "an account with that email already exists");
            replaceRoles(result.id, "manual", input.roles);
            return { id: result.id };
          },
          invite: async (call, { userId }) => {
            if (!canInvite()) throw new OperationError(400, "invites aren't set up here");
            assertTarget(call.userId, userId, "invited");
            const account = (await options.accounts.list()).find((a) => a.id === userId);
            const result = account ? await need("reinvite")(userId) : ({ error: "not-found" } as const);
            if ("error" in result) {
              if (result.error === "idp") throw new OperationError(502, `the identity provider refused: ${result.message}`);
              if (result.error === "accepted") throw new OperationError(409, "they already accepted their invite");
              throw new OperationError(404, "no such account");
            }
            return deliver(call, { userId, email: account!.email, displayName: account!.displayName }, result.token, result.expiresAt, true);
          },
          revokeInvite: async (_call, { userId }) => {
            await need("revokeInvite")(userId);
            return {};
          },
          resetMfa: async (call, { userId }) => {
            // Root's second factor is reset only on the server (a CLI command), so a stolen admin session can't strip it.
            if (userId === root()) throw new OperationError(400, "root's two-step login can only be reset on the server");
            if (userId === call.userId) throw new OperationError(400, "you can't reset your own two-step login; remove factors on the Security page");
            await need("resetMfa")(userId);
            return {};
          },
          disableUser: async (call, { userId }) => {
            assertTarget(call.userId, userId, "disabled", true);
            await need("disable")(userId);
            return {};
          },
          enableUser: async (_call, { userId }) => {
            await need("enable")(userId);
            return {};
          },
          revokeSessions: async (call, { userId }) => {
            assertTarget(call.userId, userId, "logged out by someone else");
            await need("revokeSessions")(userId);
            return {};
          },
          resetPassword: async (call, { userId, password }) => {
            assertTarget(call.userId, userId, "reset by someone else");
            const result = await need("resetPassword")(userId, password);
            if ("error" in result) throw new OperationError(400, "this account has no password login (it signs in through the identity provider)");
            return {};
          },
          setUserRoles: (_call, { userId, roles }) => {
            seed();
            assertRolesExist(roles);
            replaceRoles(userId, "manual", roles);
            return {};
          },
          putRole: (_call, { name, description, policies }) => {
            seed();
            const sql = db();
            const known = new Set((sql.prepare("SELECT name FROM iam_policy").all() as { name: string }[]).map((p) => p.name));
            const unknown = policies.filter((p) => !known.has(p));
            if (unknown.length > 0) throw new OperationError(400, `unknown policy: ${unknown.join(", ")}`);
            sql.transaction(() => {
              sql
                .prepare("INSERT INTO iam_role (name, description) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET description = excluded.description")
                .run(name, description);
              sql.prepare("DELETE FROM iam_role_policy WHERE role = ?").run(name);
              for (const policy of new Set(policies)) sql.prepare("INSERT INTO iam_role_policy (role, policy) VALUES (?, ?)").run(name, policy);
            })();
            changed();
            return {};
          },
          deleteRole: (_call, { name }) => {
            const sql = db();
            sql.transaction(() => {
              sql.prepare("DELETE FROM iam_user_role WHERE role = ?").run(name);
              sql.prepare("DELETE FROM iam_role_policy WHERE role = ?").run(name);
              sql.prepare("DELETE FROM iam_role WHERE name = ?").run(name);
            })();
            changed();
            return {};
          },
          putPolicy: (_call, { name, description, document }) => {
            seed();
            if (name in managedPolicies) throw new OperationError(400, `${name} is managed and can't be changed`);
            const problems = document.statements.flatMap((statement, i) => statementProblems(statement).map((p) => `statement ${i + 1}: ${p}`));
            if (problems.length > 0) throw new OperationError(400, problems.join("; "));
            db()
              .prepare(
                `INSERT INTO iam_policy (name, description, document, managed) VALUES (?, ?, ?, 0)
                 ON CONFLICT (name) DO UPDATE SET description = excluded.description, document = excluded.document`,
              )
              .run(name, description, JSON.stringify(document));
            changed();
            return {};
          },
          deletePolicy: (_call, { name }) => {
            if (name in managedPolicies) throw new OperationError(400, `${name} is managed and can't be deleted`);
            const sql = db();
            sql.transaction(() => {
              sql.prepare("DELETE FROM iam_role_policy WHERE policy = ?").run(name);
              sql.prepare("DELETE FROM iam_policy WHERE name = ?").run(name);
            })();
            changed();
            return {};
          },
        },
      };
    },
  });

  return {
    module,

    /**
     * For the host's `authorize`, and vault-service's (its self-service
     * actions are allowed unless a policy explicitly denies them).
     */
    authorize(caller: Caller, action: string, resource?: ResourceCheck): boolean {
      return allowedFor(caller.userId, action, resource);
    },

    /** Whether this account is root (e.g. to keep it out of vault-service's `linkByEmail`). */
    isRoot(userId: number): boolean {
      seed();
      return userId === root();
    },

    /** For vault-service's `onLogin`: OIDC role mapping, and default roles for new signups. */
    onLogin(event: IamLoginEvent): void {
      seed();
      if (event.created && options.defaultRoles?.length) {
        const known = roleNames();
        replaceRoles(event.userId, "manual", options.defaultRoles.filter((r) => known.has(r)));
      }
      if (event.provider === "oidc" && options.oidc && event.claims) {
        const fromIdp = (options.oidc.rolesFromClaims ?? zitadelRoles)(event.claims);
        const known = roleNames();
        const mapped = fromIdp.map((r) => options.oidc!.roleMap[r]).filter((r): r is string => r !== undefined && known.has(r));
        replaceRoles(event.userId, "oidc", mapped);
      }
    },
  };
}

export type Iam = ReturnType<typeof createIam>;
