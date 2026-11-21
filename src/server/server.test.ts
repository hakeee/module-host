import { createLegacyScope, createVaultScope, deriveScopeKeys, generateDek, type VaultHandle } from "@hakeee/vault-service";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { blob, integer, sqliteTable } from "drizzle-orm/sqlite-core";
import Fastify from "fastify";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OperationError, defineContract } from "../contract.js";
import { ModuleCompositionError } from "../resolve.js";
import { createServerHost, defineServerModule, migrateModules, migrationsTableFor, type AnyServerModule } from "./index.js";

// --- fixtures ---------------------------------------------------------------

const peopleContract = defineContract({
  id: "people",
  version: 1,
  queries: {
    get: { input: z.object({ id: z.number() }), output: z.object({ id: z.number(), name: z.string() }).nullable() },
    labels: {
      input: z.object({ ids: z.array(z.number()) }),
      output: z.array(z.object({ id: z.number(), label: z.string().nullable() })),
    },
  },
  commands: {
    create: { input: z.object({ name: z.string().min(1) }), output: z.object({ id: z.number() }) },
  },
  events: { created: z.object({ id: z.number() }) },
  pages: { detail: { path: "/people/:id", params: z.object({ id: z.coerce.number() }) } },
  entities: { person: { page: "detail", labels: "labels" } },
});

// vault-service's own `user` table, redeclared: importing it from the linked
// repo would bring a second drizzle copy whose types don't line up.
const user = sqliteTable("user", { id: integer("id").primaryKey() });

const peopleTable = sqliteTable("people_person", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => user.id),
  name: blob("name", { mode: "buffer" }).notNull(),
});

const people = defineServerModule({
  contract: peopleContract,
  schema: { peopleTable },
  implement: {
    queries: {
      get: (call, { id }) => {
        const row = db.select().from(peopleTable).where(eq(peopleTable.id, id)).get();
        if (id === 999) throw new OperationError(404, "no such person");
        if (id === 666) throw new Error("SQLITE_ERROR: no such column people_person.secret");
        if (!row || row.userId !== call.userId) return null;
        // An extra field the contract doesn't declare - must be stripped by output validation.
        return { id: row.id, name: call.vault.decryptString("person.name", row.name), secret: "x" } as never;
      },
      labels: (call, { ids }) =>
        ids.map((id) => {
          const row = db.select().from(peopleTable).where(eq(peopleTable.id, id)).get();
          return { id, label: row ? call.vault.decryptString("person.name", row.name) : null };
        }),
    },
    commands: {
      create: (call, { name }) => {
        const row = db
          .insert(peopleTable)
          .values({ userId: call.userId, name: call.vault.encryptString("person.name", name) })
          .returning()
          .get();
        return { id: row.id };
      },
    },
  },
  setup(ctx) {
    peopleCtx = ctx;
  },
});
let peopleCtx: { emit: (caller: never, event: "created", payload: { id: number }) => Promise<void> } | undefined;

const journalContract = defineContract({
  id: "journal",
  version: 1,
  queries: { mentionLabels: { input: z.object({}), output: z.array(z.string().nullable()) } },
});

const journalMention = sqliteTable("journal_mention", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  personId: integer("person_id").notNull().references(() => peopleTable.id),
});

const seenEvents: { module: string; id: number; scopeName: string }[] = [];

const journal = defineServerModule({
  contract: journalContract,
  requires: [people],
  schema: { journalMention },
  // The function form: handlers built from the module's own context.
  implement: (ctx) => ({
    queries: {
      mentionLabels: async (call) => {
        const ids = ctx.db.select().from(journalMention).all().map((m) => m.personId);
        const labels = await ctx.use(peopleContract).queries.labels(call, { ids });
        return labels.map((l) => l.label);
      },
    },
  }),
  setup(ctx) {
    ctx.on(peopleContract, "created", (call, payload) => {
      seenEvents.push({ module: "journal", id: payload.id, scopeName: call.vault.name });
    });
    ctx.routes((app) => {
      app.get("/whoami", async (request, reply) => {
        const call = ctx.requireCall(request, reply);
        if (!call) return;
        return { userId: call.userId, scope: call.vault.name };
      });
    });

    // Type-level isolation: a contract this module didn't require.
    const unrelated = defineContract({ id: "unrelated", version: 1 });
    // @ts-expect-error - "unrelated" isn't in journal's requires
    expect(() => ctx.use(unrelated)).toThrow(ModuleCompositionError);
  },
});

// --- a tiny vault: sessions keyed by an `x-session` header --------------------

const sqlite = new Database(":memory:");
sqlite.exec(`
  CREATE TABLE user (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE people_person (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES user(id), name BLOB NOT NULL);
  CREATE TABLE journal_mention (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES people_person(id));
  INSERT INTO user VALUES (1, 'A', 'a@example.com', 0);
`);
const db = drizzle(sqlite);

const sessions = new Map<string, { userId: number; dek: Buffer }>([["s1", { userId: 1, dek: generateDek() }]]);
function vaultFor(sessionId: string): VaultHandle | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  return {
    userId: session.userId,
    scope: (name: string) => createVaultScope(name, deriveScopeKeys(session.dek, name)),
    legacy: createLegacyScope(session.dek),
  };
}

function buildHost(modules: readonly AnyServerModule[], extra: Partial<Parameters<typeof createServerHost>[0]> = {}) {
  return createServerHost({
    modules,
    db,
    sharedTables: ["user"],
    vaultFor,
    requireVault(request, reply) {
      const sessionId = request.headers["x-session"] as string | undefined;
      const vault = sessionId ? vaultFor(sessionId) : undefined;
      if (!sessionId || !vault) {
        reply.code(423).send({ error: "vault locked" });
        return undefined;
      }
      return { sessionId, userId: vault.userId, vault };
    },
    ...extra,
  });
}

const caller = { userId: 1, sessionId: "s1" };

// --- tests -------------------------------------------------------------------

describe("composition", () => {
  it("pulls in required modules, requirements first", () => {
    expect(buildHost([journal]).modules.map((m) => m.id)).toEqual(["people", "journal"]);
  });

  it("requires a contract-only requirement to be implemented by someone", () => {
    const ui = defineServerModule({ id: "people-extras", requires: [peopleContract] });
    expect(() => buildHost([ui])).toThrow(/requires contract "people", but no module implements it/);
    expect(buildHost([ui, people]).modules.map((m) => m.id)).toEqual(["people-extras", "people"]);
  });

  it("refuses version mismatches", () => {
    const peopleV2 = defineContract({ id: "people", version: 2 });
    const builtAgainstV2 = defineServerModule({ id: "needs-v2", requires: [peopleV2] });
    expect(() => buildHost([builtAgainstV2, people])).toThrow(/built against "people" v2, but "people" implements v1/);
  });

  it("refuses two implementations, duplicate ids and cycles", () => {
    const otherPeople = defineServerModule({ id: "people", contract: defineContract({ id: "people", version: 1 }), implement: {} });
    expect(() => buildHost([people, otherPeople])).toThrow(ModuleCompositionError);

    const a: { requires: AnyServerModule[] } & AnyServerModule = { ...defineServerModule({ id: "a" }), requires: [] } as never;
    const b = defineServerModule({ id: "b", requires: [a] });
    a.requires.push(b);
    expect(() => buildHost([a])).toThrow(/cycle a -> b -> a/);
  });

  it("refuses missing or unknown operation implementations", () => {
    const partial = defineServerModule({
      contract: peopleContract,
      implement: { queries: { get: () => null } } as never,
    });
    expect(() => buildHost([partial])).toThrow(/doesn't implement people\.labels/);
  });
});

describe("database isolation", () => {
  const t = (name: string) => sqliteTable(name, { id: integer("id").primaryKey() });

  it("enforces the <id>_ prefix unless a table is grandfathered", () => {
    const m = defineServerModule({ id: "notes", schema: { t: t("note") } });
    expect(() => buildHost([m])).toThrow(/must be named "notes_\.\.\."/);
    const grandfathered = defineServerModule({ id: "notes", schema: { t: t("note") }, legacyTableNames: ["note"] });
    expect(() => buildHost([grandfathered])).not.toThrow();
  });

  it("allows foreign keys only into required modules and shared tables", () => {
    const stray = sqliteTable("habits_link", {
      id: integer("id").primaryKey(),
      personId: integer("person_id").references(() => peopleTable.id),
    });
    const viaContract = defineServerModule({ id: "habits", requires: [peopleContract], schema: { stray } });
    expect(() => buildHost([viaContract, people])).toThrow(/doesn't require module "people"/);

    const viaModule = defineServerModule({ id: "habits", requires: [people], schema: { stray } });
    expect(() => buildHost([viaModule])).not.toThrow();
  });

  it("refuses two modules claiming one table", () => {
    const a = defineServerModule({ id: "a", schema: { t: t("shared_t") }, legacyTableNames: ["shared_t"] });
    const b = defineServerModule({ id: "b", schema: { t: t("shared_t") }, legacyTableNames: ["shared_t"] });
    expect(() => buildHost([a, b])).toThrow(/claimed by both/);
  });
});

describe("calls", () => {
  it("serves contract operations over HTTP with validation and the module's own scope", async () => {
    const host = buildHost([journal]);
    const app = Fastify();
    await app.register(host.routes, { prefix: "/m" });

    const rpc = (path: string, body: unknown, session?: string) =>
      app.inject({ method: "POST", url: `/m/${path}`, payload: body as object, headers: session ? { "x-session": session } : {} });

    expect((await rpc("people/rpc/create", { name: "Erik" })).statusCode).toBe(423);
    expect((await rpc("people/rpc/create", { name: "" }, "s1")).statusCode).toBe(400);
    expect((await rpc("people/rpc/nope", {}, "s1")).statusCode).toBe(404);
    // Names from the URL never reach Object.prototype.
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect((await rpc(`people/rpc/${name}`, {}, "s1")).statusCode).toBe(404);
    }

    const { id } = (await rpc("people/rpc/create", { name: "Erik" }, "s1")).json();
    const missing = await rpc("people/rpc/get", { id: 999 }, "s1");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "no such person" });
    expect((await rpc("people/rpc/get", { id }, "s1")).json()).toEqual({ id, name: "Erik" }); // `secret` stripped
    const logError = vi.fn();
    const quiet = Fastify();
    await quiet.register(buildHost([journal], { logError }).routes, { prefix: "/m" });
    const crash = await quiet.inject({ method: "POST", url: "/m/people/rpc/get", payload: { id: 666 }, headers: { "x-session": "s1" } });
    expect(crash.statusCode).toBe(500);
    expect(crash.json()).toEqual({ error: "internal error" }); // the message stays in the log
    expect(logError).toHaveBeenCalledOnce();

    const whoami = await app.inject({ method: "GET", url: "/m/journal/whoami", headers: { "x-session": "s1" } });
    expect(whoami.json()).toEqual({ userId: 1, scope: "journal" });

    const manifest = await app.inject({ method: "GET", url: "/m/_manifest" });
    expect(manifest.json().modules).toEqual([
      { id: "people", contract: { id: "people", version: 1 } },
      { id: "journal", contract: { id: "journal", version: 1 } },
    ]);
  });

  it("lets modules call each other in-process; each decrypts only its own data", async () => {
    const host = buildHost([journal]);
    const { id } = await host.client(peopleContract).commands.create(caller, { name: "Anna" });
    db.insert(journalMention).values({ personId: id }).run();

    expect(await host.client(journalContract).queries.mentionLabels(caller, {})).toContain("Anna");

    const row = db.select().from(peopleTable).where(eq(peopleTable.id, id)).get()!;
    const journalScope = vaultFor("s1")!.scope("journal");
    expect(() => journalScope.decryptString("person.name", row.name)).toThrow();
  });

  it("throws ModuleVaultLockedError in-process for a locked session", async () => {
    const host = buildHost([people]);
    await expect(host.client(peopleContract).queries.get({ userId: 1, sessionId: "gone" }, { id: 1 })).rejects.toThrow("vault locked");
    await expect(host.client(peopleContract).queries.get({ userId: 2, sessionId: "s1" }, { id: 1 })).rejects.toThrow("vault locked");
  });

  it("delivers events with the subscriber's own context, and isolates handler failures", async () => {
    const logError = vi.fn();
    const failing = defineServerModule({
      id: "failing",
      requires: [people],
      setup(ctx) {
        ctx.on(peopleContract, "created", () => {
          throw new Error("boom");
        });
      },
    });
    buildHost([journal, failing], { logError });
    seenEvents.length = 0;
    await peopleCtx!.emit(caller as never, "created", { id: 42 });
    expect(seenEvents).toEqual([{ module: "journal", id: 42, scopeName: "journal" }]);
    expect(logError).toHaveBeenCalledOnce();
  });
});

describe("vault: false operations", () => {
  const profileContract = defineContract({
    id: "profile",
    version: 1,
    queries: {
      greeting: { input: z.object({}), output: z.string(), vault: false },
      secret: { input: z.object({}), output: z.string() },
    },
  });
  const profile = defineServerModule({
    contract: profileContract,
    implement: {
      queries: {
        greeting: (call) => {
          // @ts-expect-error - no vault scope while locked
          void call.vault;
          expect("vault" in call).toBe(false);
          return `hello ${call.userId}`;
        },
        secret: (call) => call.vault.name,
      },
    },
  });
  // Logged in = an `x-user` header; the session id is `x-session`, unlocked or not.
  const requireCaller = (request: { headers: Record<string, unknown> }, reply: { code(n: number): { send(b: unknown): void } }) => {
    const userId = Number(request.headers["x-user"]);
    if (!userId) {
      reply.code(401).send({ error: "login required" });
      return undefined;
    }
    return { userId, sessionId: String(request.headers["x-session"] ?? "locked") };
  };

  it("needs the host's requireCaller", () => {
    expect(() => buildHost([profile])).toThrow(/profile.greeting has vault: false/);
  });

  it("serves them to a logged-in caller with a locked vault, and nothing else", async () => {
    const host = buildHost([profile], { requireCaller: requireCaller as never });
    const app = Fastify();
    await app.register(host.routes, { prefix: "/m" });
    const rpc = (op: string, headers: Record<string, string>) =>
      app.inject({ method: "POST", url: `/m/profile/rpc/${op}`, payload: {}, headers });

    expect((await rpc("greeting", {})).statusCode).toBe(401);
    const locked = await rpc("greeting", { "x-user": "7" });
    expect(locked.statusCode).toBe(200);
    expect(locked.json()).toBe("hello 7");
    expect((await rpc("secret", { "x-user": "7" })).statusCode).toBe(423);
    expect((await rpc("secret", { "x-user": "1", "x-session": "s1" })).json()).toBe("profile");
  });

  it("runs them in-process for a locked caller", async () => {
    const host = buildHost([profile], { requireCaller: requireCaller as never });
    expect(await host.client(profileContract).queries.greeting({ userId: 3, sessionId: "gone" }, {})).toBe("hello 3");
    await expect(host.client(profileContract).queries.secret({ userId: 3, sessionId: "gone" }, {})).rejects.toThrow("vault locked");
  });
});

describe("migrations", () => {
  it("applies each module's migrations with its own tracking table", () => {
    const folder = mkdtempSync(join(tmpdir(), "module-host-"));
    mkdirSync(join(folder, "meta"));
    writeFileSync(
      join(folder, "meta/_journal.json"),
      JSON.stringify({ version: "7", dialect: "sqlite", entries: [{ idx: 0, version: "6", when: 1, tag: "0000_x", breakpoints: true }] }),
    );
    writeFileSync(join(folder, "0000_x.sql"), "CREATE TABLE `notes_note` (`id` integer PRIMARY KEY);");

    const fresh = drizzle(new Database(":memory:"));
    const notes = defineServerModule({ id: "notes", migrationsFolder: folder });
    const host = createServerHost({ modules: [notes], db: fresh, vaultFor, requireVault: () => undefined });
    host.migrate();
    migrateModules(fresh, [notes]); // the standalone form, same tracking table
    const rows = fresh.$client.prepare(`SELECT count(*) AS n FROM ${migrationsTableFor("notes")}`).get() as { n: number };
    expect(rows.n).toBe(1);
    expect(migrationsTableFor("notes-v2")).toBe("__module_notes_v2_migrations");
  });
});

describe("types", () => {
  it("checks inputs, outputs and handler signatures against the contract", () => {
    const host = buildHost([people]);
    const client = host.client(peopleContract);
    // @ts-expect-error - name must be a string
    void client.commands.create(caller, { name: 3 }).catch(() => {});
    // @ts-expect-error - no such query
    void client.queries.nope;
    void (async () => {
      const person = await client.queries.get(caller, { id: 1 }).catch(() => null);
      // @ts-expect-error - output is { id, name } | null; no `secret`
      void person?.secret;
    });

    defineServerModule({
      contract: peopleContract,
      implement: {
        queries: {
          // @ts-expect-error - must return { id, name } | null
          get: () => ({ id: "not a number" }),
          labels: () => [],
        },
        commands: { create: () => ({ id: 1 }) },
      },
    });

    // @ts-expect-error - a contract with operations needs `implement`
    defineServerModule({ contract: peopleContract });
  });
});
