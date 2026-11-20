import { createLegacyScope, createVaultScope, deriveScopeKeys, generateDek, type VaultHandle } from "@hakeee/vault-service";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract } from "../contract.js";
import { createServerHost, defineServerModule } from "../server/index.js";
import { iamContract } from "./contract.js";
import { createIam } from "./server.js";

// A clients module: `list` filters per record (declares the resource), `names` redacts, `count` doesn't check records.
const clientsContract = defineContract({
  id: "clients",
  version: 1,
  resources: { client: { description: "A client of the business.", attributes: ["trainers", "archived"] } },
  queries: {
    list: { input: z.object({}), output: z.array(z.string()), vault: false, resource: "client" },
    names: { input: z.object({}), output: z.array(z.string()), vault: false, resource: "client" },
    count: { input: z.object({}), output: z.number(), vault: false },
  },
});
const rows = [
  { id: 1, name: "Bára", trainers: [2], archived: false },
  { id: 2, name: "Jana", trainers: [3], archived: false },
  { id: 3, name: "Old", trainers: [2], archived: true },
];
const clients = defineServerModule({
  contract: clientsContract,
  implement: (ctx) => {
    const ref = (r: (typeof rows)[number]) => clientsContract.resources.client.of(r.id, { trainers: r.trainers, archived: r.archived });
    return {
      queries: {
        list: async (call) => (await ctx.filter(call, "clients:list", rows, ref)).map((r) => r.name),
        names: async (call) => Promise.all(rows.map(async (r) => ((await ctx.can(call, "clients:names", ref(r))) ? r.name : "Private"))),
        count: () => rows.length,
      },
    };
  },
});

function setup() {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE user (id INTEGER PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL)");
  for (const email of ["root@x", "tereza@x", "marek@x"]) sqlite.prepare("INSERT INTO user (email, display_name) VALUES (?, ?)").run(email, email);
  const sessions = new Map<string, Buffer>();
  const vaultFor = (sessionId: string): VaultHandle | undefined => {
    const dek = sessions.get(sessionId);
    const userId = Number(sessionId.slice(1));
    return dek && { userId, scope: (n: string) => createVaultScope(n, deriveScopeKeys(dek, n)), legacy: createLegacyScope(dek) };
  };
  const iam = createIam({ accounts: { list: () => [] } });
  const host = createServerHost({
    modules: [iam.module, clients],
    db: drizzle(sqlite),
    sharedTables: ["user"],
    vaultFor,
    requireVault: (_r, reply) => void reply.code(401).send({}),
    requireCaller: (_r, reply) => void reply.code(401).send({}),
    authorize: iam.authorize,
  });
  host.migrate();
  const caller = (userId: number) => {
    sessions.set(`s${userId}`, generateDek());
    return { userId, sessionId: `s${userId}` };
  };
  return { host, iam, caller };
}

describe("IAM resources", () => {
  it("filters and redacts per record, with conditions and ${user.id}", async () => {
    const { host, caller } = setup();
    const root = caller(1);
    const iam = host.client(iamContract);
    // Trainers: their own active clients' records; any client's name on the schedule is not theirs to see.
    await iam.commands.putPolicy(root, {
      name: "MyClients",
      description: "",
      document: {
        version: 1,
        statements: [
          { effect: "allow", actions: ["clients:list", "clients:names"], conditions: { "clients:trainers": "${user.id}" } },
          { effect: "deny", actions: ["clients:*"], conditions: { "clients:archived": "true" } },
          { effect: "allow", actions: ["clients:count"], resources: ["clients:client/*"] },
        ],
      },
    });
    await iam.commands.putRole(root, { name: "trainer", description: "", policies: ["MyClients"] });
    await iam.commands.setUserRoles(root, { userId: 2, roles: ["trainer"] });
    await iam.commands.setUserRoles(root, { userId: 3, roles: ["trainer"] });

    const c = host.client(clientsContract);
    expect(await c.queries.list(caller(2), {})).toEqual(["Bára"]); // not Jana (Marek's), not Old (archived)
    expect(await c.queries.list(caller(3), {})).toEqual(["Jana"]);
    expect(await c.queries.names(caller(2), {})).toEqual(["Bára", "Private", "Private"]);
    expect(await c.queries.list(root, {})).toEqual(["Bára", "Jana", "Old"]); // root: everything
    // `count` doesn't check records, so a record-scoped allow doesn't open it.
    await expect(c.queries.count(caller(2), {})).rejects.toMatchObject({ status: 403 });
  });

  it("lists resource types and marks record-checking actions, for editors", async () => {
    const { host, caller } = setup();
    const iam = host.client(iamContract);
    expect(await iam.queries.resources(caller(1), {})).toEqual([
      { type: "clients:client", description: "A client of the business.", attributes: ["clients:trainers", "clients:archived"] },
    ]);
    const actions = await iam.queries.actions(caller(1), {});
    expect(actions.find((a) => a.action === "clients:list")).toEqual({ action: "clients:list", kind: "query", resource: "clients:client" });
    expect(actions.find((a) => a.action === "clients:count")).toEqual({ action: "clients:count", kind: "query" });
  });

  it("refuses to save statements that could never match", async () => {
    const { host, caller } = setup();
    const put = (statement: object) =>
      host.client(iamContract).commands.putPolicy(caller(1), { name: "Bad", description: "", document: { version: 1, statements: [statement as never] } });
    await expect(put({ effect: "allow", actions: ["*"], conditions: { "clients:trainers": "${user.email}" } })).rejects.toMatchObject({ status: 400 });
    await expect(put({ effect: "allow", actions: ["*"], resources: ["42"] })).rejects.toMatchObject({ status: 400 });
  });

  it("checks contracts: resource names and operations naming unknown resources", () => {
    expect(() => defineContract({ id: "x", version: 1, queries: { a: { input: z.object({}), output: z.number(), resource: "nope" } } })).toThrow(/unknown resource "nope"/);
    expect(clientsContract.resources.client.of(5, { trainers: [1], archived: false, other: 1 } as never)).toEqual({
      id: "clients:client/5",
      attributes: { "clients:trainers": [1], "clients:archived": false },
    });
    expect(() => clientsContract.resources.client.of("a/b")).toThrow(/can't contain/);
  });
});
