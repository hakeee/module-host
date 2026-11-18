import { fileURLToPath } from "node:url";
import { OperationError, type ActionKind } from "../contract.js";
import type { Caller } from "../client.js";
import { defineServerModule } from "../server/index.js";
import { iamContract } from "./contract.js";
import { MANAGED_POLICIES, STARTER_ROLES, evaluate, type PolicyDocument, type PolicyStatement } from "./policy.js";
import { iamPolicy, iamRole, iamRolePolicy, iamRoot, iamUserRole } from "./schema.js";

export interface IamAccount {
  id: number;
  email: string;
  displayName: string;
}

/**
 * Where accounts live - IAM only attaches roles to them. With vault-service:
 * `createAccountStore(db)`. Leave out `create` where accounts come from
 * elsewhere (OIDC): the admin UI then can't create them.
 */
export interface IamAccounts {
  list(): IamAccount[] | Promise<IamAccount[]>;
  create?(input: { email: string; password: string; displayName: string }): Promise<{ id: number } | { error: "email-taken" }>;
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
   * OIDC: IdP role -> IAM role, applied at every login (replacing the
   * previous login's). `rolesFromClaims` reads the IdP roles; the default
   * understands Zitadel's `urn:zitadel:iam:org:project[:<id>]:roles` claim.
   */
  oidc?: { roleMap: Readonly<Record<string, string>>; rolesFromClaims?: (claims: Record<string, unknown>) => string[] };
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
  let raw: Raw | undefined;
  let actionKinds: Map<string, ActionKind> | undefined;
  let listActions: () => readonly { action: string; kind: ActionKind }[] = () => [];
  let seeded = false;
  let rootId: number | undefined;
  const statementsByUser = new Map<number, PolicyStatement[]>();

  const db = () => {
    if (!raw) throw new Error("IAM: the module isn't installed in a server host");
    return raw;
  };
  const kindOf = (action: string) => (actionKinds ??= new Map(listActions().map((a) => [a.action, a.kind]))).get(action);
  const changed = () => statementsByUser.clear();

  /** Managed policies always match this code; starter roles only appear on a fresh install. */
  const seed = () => {
    if (seeded) return;
    const sql = db();
    sql.transaction(() => {
      const fresh = !sql.prepare("SELECT 1 FROM iam_root").get() && !sql.prepare("SELECT 1 FROM iam_role").get();
      for (const [name, policy] of Object.entries(MANAGED_POLICIES)) {
        sql
          .prepare(
            `INSERT INTO iam_policy (name, description, document, managed) VALUES (?, ?, ?, 1)
             ON CONFLICT (name) DO UPDATE SET description = excluded.description, document = excluded.document, managed = 1`,
          )
          .run(name, policy.description, JSON.stringify(policy.document));
      }
      if (fresh) {
        for (const [name, role] of Object.entries(STARTER_ROLES)) {
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
      return {
        queries: {
          myAccess: (call) => {
            seed();
            return { userId: call.userId, root: call.userId === root(), statements: statementsFor(call.userId) };
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
              ...a,
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
          settings: () => ({ canCreateUsers: options.accounts.create !== undefined }),
        },
        commands: {
          createUser: async (_call, input) => {
            if (!options.accounts.create) throw new OperationError(400, "accounts can't be created here");
            seed();
            assertRolesExist(input.roles);
            const result = await options.accounts.create({
              email: input.email,
              password: input.password,
              displayName: input.displayName?.trim() || input.email,
            });
            if ("error" in result) throw new OperationError(409, "an account with that email already exists");
            replaceRoles(result.id, "manual", input.roles);
            return { id: result.id };
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
            if (name in MANAGED_POLICIES) throw new OperationError(400, `${name} is managed and can't be changed`);
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
            if (name in MANAGED_POLICIES) throw new OperationError(400, `${name} is managed and can't be deleted`);
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

    /** For the host's `authorize`. */
    authorize(caller: Caller, action: string): boolean {
      if (ALWAYS_ALLOWED.has(action)) return true;
      seed();
      if (caller.userId === root()) return true;
      return evaluate(statementsFor(caller.userId), action, kindOf);
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
