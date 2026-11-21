import { createLegacyScope, createVaultScope, deriveScopeKeys, generateDek, type VaultHandle } from "@hakeee/vault-service";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract } from "../contract.js";
import { JOBS_TABLE, createServerHost, defineServerModule } from "../server/index.js";
import { iamContract } from "./contract.js";
import { createIam, zitadelRoles, type IamAccount } from "./server.js";

// Sessions by id ("s<userId>" when unlocked); logged in = an x-user header.
const sessions = new Map<string, { userId: number; dek: Buffer }>();
const vaultFor = (sessionId: string): VaultHandle | undefined => {
  const s = sessions.get(sessionId);
  return s && { userId: s.userId, scope: (n: string) => createVaultScope(n, deriveScopeKeys(s.dek, n)), legacy: createLegacyScope(s.dek) };
};
const unlock = (userId: number) => {
  sessions.set(`s${userId}`, { userId, dek: generateDek() });
  return { userId, sessionId: `s${userId}` };
};

const notesContract = defineContract({
  id: "notes",
  version: 1,
  queries: { list: { input: z.object({}), output: z.array(z.string()) } },
  commands: { create: { input: z.object({ text: z.string() }), output: z.object({}) } },
});
let notesCtx: any;
const notes = defineServerModule({
  contract: notesContract,
  jobs: { reindex: z.object({}) },
  implement: { queries: { list: () => ["a"] }, commands: { create: () => ({}) } },
  setup(ctx) {
    notesCtx = ctx;
    ctx.jobs.handle("reindex", () => {});
  },
});

const accountCalls: string[] = [];

function setup(options: Partial<Parameters<typeof createIam>[0]> = {}) {
  sessions.clear();
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE user (id INTEGER PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL)");
  const db = drizzle(sqlite);
  const accounts = {
    list: (): IamAccount[] =>
      (sqlite.prepare("SELECT id, email, display_name AS displayName FROM user ORDER BY id").all() as IamAccount[]),
    async create(input: { email: string; password: string; displayName: string }) {
      if (sqlite.prepare("SELECT 1 FROM user WHERE email = ?").get(input.email)) return { error: "email-taken" as const };
      const r = sqlite.prepare("INSERT INTO user (email, display_name) VALUES (?, ?)").run(input.email, input.displayName);
      return { id: Number(r.lastInsertRowid) };
    },
    async disable(userId: number) {
      accountCalls.push(`disable ${userId}`);
    },
    async enable(userId: number) {
      accountCalls.push(`enable ${userId}`);
    },
    async revokeSessions(userId: number) {
      accountCalls.push(`revoke ${userId}`);
    },
    async resetPassword(userId: number) {
      accountCalls.push(`reset ${userId}`);
      return userId === 99 ? ({ error: "no-local-login" } as const) : ({ ok: true } as const);
    },
    async invite(input: { email: string; displayName: string }) {
      if (input.email.endsWith("@refused.example")) return { error: "idp" as const, message: "user already exists" };
      const created = await accounts.create({ ...input, password: "" });
      return "error" in created ? created : { ...created, token: `t${created.id}`, expiresAt: new Date("2030-01-01T00:00:00Z") };
    },
    async reinvite(userId: number) {
      accountCalls.push(`reinvite ${userId}`);
      return userId === 98 ? ({ error: "accepted" } as const) : { token: `t${userId}b`, expiresAt: new Date("2030-01-02T00:00:00Z") };
    },
    async revokeInvite(userId: number) {
      accountCalls.push(`revokeInvite ${userId}`);
    },
    async resetMfa(userId: number) {
      accountCalls.push(`resetMfa ${userId}`);
    },
  };
  const iam = createIam({ accounts, defaultRoles: ["member"], oidc: { roleMap: { "app-admin": "admin" } }, ...options });
  const host = createServerHost({
    modules: [iam.module, notes],
    db,
    sharedTables: ["user"],
    vaultFor,
    requireVault(request, reply) {
      const sessionId = `s${request.headers["x-user"]}`;
      const vault = vaultFor(sessionId);
      if (!vault) {
        reply.code(423).send({ error: "vault locked" });
        return undefined;
      }
      return { sessionId, userId: vault.userId, vault };
    },
    requireCaller(request, reply) {
      const userId = Number(request.headers["x-user"]);
      if (!userId) {
        reply.code(401).send({ error: "login required" });
        return undefined;
      }
      return { userId, sessionId: `s${userId}` };
    },
    authorize: iam.authorize,
    extraActions: [{ action: "vault:setRecoveryKey", kind: "self-service" }],
  });
  host.migrate();
  const addUser = (email: string) => Number(sqlite.prepare("INSERT INTO user (email, display_name) VALUES (?, ?)").run(email, email).lastInsertRowid);
  return { host, iam, sqlite, addUser };
}

async function http(host: ReturnType<typeof setup>["host"]) {
  const app = Fastify();
  await app.register(host.routes, { prefix: "/m" });
  return (path: string, userId: number, body: object = {}) =>
    app.inject({ method: "POST", url: `/m/${path}`, payload: body, headers: { "x-user": String(userId) } });
}

describe("IAM", () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  it("makes the first account root, allowed everything; others get nothing without roles", async () => {
    const root = env.addUser("root@example.com");
    const other = env.addUser("other@example.com");
    const rpc = await http(env.host);
    expect((await rpc("notes/rpc/list", root)).statusCode).toBe(423); // allowed, but its vault is locked
    unlock(root);
    unlock(other);
    expect((await rpc("notes/rpc/create", root, { text: "x" })).statusCode).toBe(200);

    const denied = await rpc("notes/rpc/list", other);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "not allowed: notes:list" });
    // Their own permissions are always readable, even locked and with no roles.
    sessions.delete(`s${other}`);
    const access = await rpc("iam/rpc/myAccess", other);
    expect(access.statusCode).toBe(200);
    expect(access.json()).toEqual({ userId: other, root: false, statements: [], selfService: [{ action: "vault:setRecoveryKey", allowed: true }] });
  });

  it("seeds admin and member; member reads but can't write, from the browser or in-process", async () => {
    const root = env.addUser("root@example.com");
    const member = env.addUser("m@example.com");
    const client = env.host.client(iamContract);
    unlock(root);
    expect((await client.queries.roles(unlock(root), {})).map((r) => r.name)).toEqual(["admin", "member"]);
    await client.commands.setUserRoles(unlock(root), { userId: member, roles: ["member"] });

    const rpc = await http(env.host);
    unlock(member);
    expect((await rpc("notes/rpc/list", member)).statusCode).toBe(200);
    expect((await rpc("notes/rpc/create", member, { text: "x" })).statusCode).toBe(403);
    await expect(env.host.client(notesContract).commands.create(unlock(member), { text: "x" })).rejects.toMatchObject({ status: 403 });
    // IAM's own operations are actions too: a member can't change roles.
    await expect(client.commands.setUserRoles(unlock(member), { userId: member, roles: ["admin"] })).rejects.toMatchObject({ status: 403 });
  });

  it("seeds the app's own managed policies and starter roles instead of the built-in roles", async () => {
    env = setup({
      policies: { NotesReader: { description: "Read notes.", document: { version: 1, statements: [{ effect: "allow", actions: ["notes:list"] }] } } },
      starterRoles: { reader: { description: "Reads notes.", policies: ["NotesReader"] } },
    });
    const asRoot = unlock(env.addUser("root@example.com"));
    const reader = env.addUser("r@example.com");
    const iam = env.host.client(iamContract);
    expect((await iam.queries.roles(asRoot, {})).map((r) => r.name)).toEqual(["reader"]);
    const policies = await iam.queries.policies(asRoot, {});
    expect(policies.filter((p) => p.managed).map((p) => p.name).sort()).toEqual(["AdministratorAccess", "NotesReader", "ReadOnlyAccess"]);
    await expect(
      iam.commands.putPolicy(asRoot, { name: "NotesReader", description: "", document: { version: 1, statements: [] } }),
    ).rejects.toMatchObject({ status: 400 });
    await iam.commands.setUserRoles(asRoot, { userId: reader, roles: ["reader"] });
    expect(env.iam.authorize(unlock(reader), "notes:list")).toBe(true);
    expect(env.iam.authorize(unlock(reader), "notes:create")).toBe(false);

    expect(() => setup({ policies: { ReadOnlyAccess: { description: "", document: { version: 1, statements: [] } } } })).toThrow(/built in/);
    expect(() => setup({ starterRoles: { x: { description: "", policies: ["Missing"] } } })).toThrow(/isn't a managed policy/);
  });

  it("lets a custom deny override an allow, and protects managed policies", async () => {
    const root = env.addUser("root@example.com");
    const user = env.addUser("u@example.com");
    const asRoot = unlock(root);
    const iam = env.host.client(iamContract);
    await iam.commands.putPolicy(asRoot, {
      name: "NoNoteWrites",
      description: "",
      document: { version: 1, statements: [{ effect: "deny", actions: ["notes:create"] }] },
    });
    await iam.commands.putRole(asRoot, { name: "editor", description: "", policies: ["AdministratorAccess", "NoNoteWrites"] });
    await iam.commands.setUserRoles(asRoot, { userId: user, roles: ["editor"] });

    const asUser = unlock(user);
    expect(env.iam.authorize(asUser, "notes:list")).toBe(true);
    expect(env.iam.authorize(asUser, "notes:create")).toBe(false);
    await expect(
      iam.commands.putPolicy(asRoot, { name: "AdministratorAccess", description: "", document: { version: 1, statements: [] } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(iam.commands.putRole(asRoot, { name: "x", description: "", policies: ["Nope"] })).rejects.toMatchObject({ status: 400 });

    await iam.commands.deleteRole(asRoot, { name: "editor" });
    expect(env.iam.authorize(asUser, "notes:list")).toBe(false); // the cache follows changes
  });

  it("creates accounts with roles, and refuses duplicate emails", async () => {
    const asRoot = unlock(env.addUser("root@example.com"));
    const iam = env.host.client(iamContract);
    const { id } = await iam.commands.createUser(asRoot, { email: "new@example.com", password: "longenough", roles: ["member"] });
    const users = await iam.queries.users(asRoot, {});
    expect(users.find((u) => u.id === id)).toMatchObject({ email: "new@example.com", root: false, roles: [{ name: "member", source: "manual" }] });
    expect(users[0]).toMatchObject({ email: "root@example.com", root: true });
    await expect(iam.commands.createUser(asRoot, { email: "new@example.com", password: "longenough", roles: [] })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("creates accounts by invite: emailed when the app can, otherwise the admin gets the link", async () => {
    accountCalls.length = 0;
    const sent: unknown[] = [];
    const link = (token: string) => `https://app.example/invite/${token}`;
    const asRoot = () => unlock(1);

    // Without `invites`, there's nothing to invite with.
    env.addUser("root@example.com");
    await expect(env.host.client(iamContract).commands.createUser(asRoot(), { email: "x@example.com", roles: [] })).rejects.toMatchObject({ status: 400 });
    expect(await env.host.client(iamContract).queries.settings(asRoot(), {})).toMatchObject({ canInvite: false, emailsInvites: false, canResetMfa: true });

    env = setup({ invites: { link, send: async (_call, mail) => void sent.push(mail) } });
    env.addUser("root@example.com");
    const iam = env.host.client(iamContract);
    expect(await iam.queries.settings(asRoot(), {})).toMatchObject({ canInvite: true, emailsInvites: true });
    const created = await iam.commands.createUser(asRoot(), { email: "new@example.com", displayName: "New", roles: ["member"] });
    expect(created.invite).toEqual({ link: null, expiresAt: "2030-01-01T00:00:00.000Z", emailed: true }); // nobody but the invitee sees the link
    expect(sent).toEqual([{ userId: created.id, email: "new@example.com", displayName: "New", link: "https://app.example/invite/t2", expiresAt: "2030-01-01T00:00:00.000Z", again: false }]);
    expect((await iam.queries.users(asRoot(), {})).find((u) => u.id === created.id)).toMatchObject({ roles: [{ name: "member", source: "manual" }], login: true, mfa: null, invite: null });

    expect(await iam.commands.invite(asRoot(), { userId: created.id })).toMatchObject({ emailed: true, link: null });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ again: true, link: "https://app.example/invite/t2b" });
    await expect(iam.commands.invite(asRoot(), { userId: 1 })).rejects.toMatchObject({ status: 400 }); // root
    await expect(iam.commands.invite(asRoot(), { userId: 77 })).rejects.toMatchObject({ status: 404 });
    await expect(iam.commands.createUser(asRoot(), { email: "new@example.com", roles: [] })).rejects.toMatchObject({ status: 409 });
    await expect(iam.commands.createUser(asRoot(), { email: "a@refused.example", roles: [] })).rejects.toMatchObject({ status: 502 });
    await iam.commands.revokeInvite(asRoot(), { userId: created.id });

    // A mail server that fails: the admin passes the link on instead.
    env = setup({ invites: { link, send: async () => Promise.reject(new Error("smtp down")) }, logError: () => {} });
    env.addUser("root@example.com");
    expect((await env.host.client(iamContract).commands.createUser(asRoot(), { email: "n@example.com", roles: [] })).invite).toEqual({
      link: "https://app.example/invite/t2",
      expiresAt: "2030-01-01T00:00:00.000Z",
      emailed: false,
    });
    expect(accountCalls).toEqual([`reinvite ${created.id}`, "revokeInvite 2"]);
  });

  it("resets someone else's MFA, never root's or your own", async () => {
    accountCalls.length = 0;
    const root = env.addUser("root@example.com");
    const admin = env.addUser("admin@example.com");
    const user = env.addUser("user@example.com");
    const iam = env.host.client(iamContract);
    await iam.commands.setUserRoles(unlock(root), { userId: admin, roles: ["admin"] });
    await iam.commands.resetMfa(unlock(admin), { userId: user });
    await expect(iam.commands.resetMfa(unlock(admin), { userId: root })).rejects.toMatchObject({ status: 400 });
    await expect(iam.commands.resetMfa(unlock(admin), { userId: admin })).rejects.toMatchObject({ status: 400 });
    expect(accountCalls).toEqual([`resetMfa ${user}`]);
  });

  it("maps OIDC roles at each login, and gives signups the default roles", async () => {
    env.addUser("root@example.com");
    const user = env.addUser("o@example.com");
    const claims = (roles: string[]) => ({ "urn:zitadel:iam:org:project:123:roles": Object.fromEntries(roles.map((r) => [r, { org: "x" }])) });
    expect(zitadelRoles(claims(["app-admin", "other"]))).toEqual(["app-admin", "other"]);

    env.iam.onLogin({ userId: user, created: true, provider: "oidc", claims: claims(["app-admin", "unmapped"]) });
    const asRoot = unlock(1);
    const roles = () => env.host.client(iamContract).queries.users(asRoot, {}).then((u) => u.find((x) => x.id === user)!.roles);
    expect(await roles()).toEqual([
      { name: "admin", source: "oidc" },
      { name: "member", source: "manual" },
    ]);

    env.iam.onLogin({ userId: user, created: false, provider: "oidc", claims: claims([]) });
    expect(await roles()).toEqual([{ name: "member", source: "manual" }]); // the IdP took admin away
  });

  it("re-checks jobs at run time, as the user who queued them", async () => {
    const root = env.addUser("root@example.com");
    const user = env.addUser("u@example.com");
    await env.host.client(iamContract).commands.setUserRoles(unlock(root), { userId: user, roles: ["admin"] });
    await notesCtx.jobs.enqueue(unlock(user), "reindex", {});
    await env.host.client(iamContract).commands.setUserRoles(unlock(root), { userId: user, roles: [] });

    await env.host.jobs.runDue();
    const row = env.sqlite.prepare(`SELECT status, error FROM ${JOBS_TABLE}`).get() as { status: string; error: string };
    expect(row).toMatchObject({ status: "queued", error: "OperationError" }); // retried later; fails for good if still denied
  });

  it("runs admin actions on other accounts, but never on root, and doesn't let you disable yourself", async () => {
    accountCalls.length = 0;
    const root = env.addUser("root@example.com");
    const admin = env.addUser("a@example.com");
    const member = env.addUser("m@example.com");
    const iam = env.host.client(iamContract);
    await iam.commands.setUserRoles(unlock(root), { userId: admin, roles: ["admin"] });
    const asAdmin = unlock(admin);

    await iam.commands.disableUser(asAdmin, { userId: member });
    await iam.commands.enableUser(asAdmin, { userId: member });
    await iam.commands.revokeSessions(asAdmin, { userId: member });
    await iam.commands.resetPassword(asAdmin, { userId: member, password: "temporary1" });
    expect(accountCalls).toEqual([`disable ${member}`, `enable ${member}`, `revoke ${member}`, `reset ${member}`]);

    await expect(iam.commands.disableUser(asAdmin, { userId: root })).rejects.toMatchObject({ status: 400 });
    await expect(iam.commands.resetPassword(asAdmin, { userId: root, password: "temporary1" })).rejects.toMatchObject({ status: 400 });
    await expect(iam.commands.disableUser(asAdmin, { userId: admin })).rejects.toMatchObject({ status: 400 });
    await expect(iam.commands.resetPassword(asAdmin, { userId: 99, password: "temporary1" })).rejects.toMatchObject({ status: 400 });
    expect(await iam.queries.settings(asAdmin, {})).toMatchObject({ canCreateUsers: true, canDisableUsers: true, canResetPasswords: true, canRevokeSessions: true });
    // A member can't do any of it.
    await expect(iam.commands.revokeSessions(unlock(member), { userId: admin })).rejects.toMatchObject({ status: 403 });
  });

  it("allows self-service actions unless a policy explicitly denies them", async () => {
    const root = env.addUser("root@example.com");
    const user = env.addUser("u@example.com");
    const asRoot = unlock(root);
    const iam = env.host.client(iamContract);
    // No roles at all, and still allowed: managing your own security is the default.
    expect(env.iam.authorize({ userId: user, sessionId: "x" }, "vault:setRecoveryKey")).toBe(true);
    expect((await iam.queries.myAccess(unlock(user), {})).selfService).toEqual([{ action: "vault:setRecoveryKey", allowed: true }]);

    await iam.commands.putPolicy(asRoot, {
      name: "NoRecoveryKeys",
      description: "",
      document: { version: 1, statements: [{ effect: "deny", actions: ["vault:setRecoveryKey"] }] },
    });
    await iam.commands.putRole(asRoot, { name: "locked-down", description: "", policies: ["NoRecoveryKeys"] });
    await iam.commands.setUserRoles(asRoot, { userId: user, roles: ["locked-down"] });
    expect(env.iam.authorize({ userId: user, sessionId: "x" }, "vault:setRecoveryKey")).toBe(false);
    expect((await iam.queries.myAccess(unlock(user), {})).selfService).toEqual([{ action: "vault:setRecoveryKey", allowed: false }]);
    expect(env.iam.authorize({ userId: root, sessionId: "x" }, "vault:setRecoveryKey")).toBe(true);
  });

  it("lists every installed action, jobs included", () => {
    const actions = env.host.actions().map((a) => `${a.action}=${a.kind}`);
    expect(actions).toContain("notes:list=query");
    expect(actions).toContain("notes:create=command");
    expect(actions).toContain("notes:reindex=job");
    expect(actions).toContain("iam:putPolicy=command");
    expect(actions).toContain("vault:setRecoveryKey=self-service");
  });
});
