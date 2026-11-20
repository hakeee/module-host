import { createLegacyScope, createVaultScope, deriveScopeKeys, generateDek, type VaultHandle } from "@hakeee/vault-service";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract } from "../contract.js";
import { ModuleCompositionError } from "../resolve.js";
import { createServerHost, defineServerModule, type ServerContext } from "./index.js";

const peopleContract = defineContract({ id: "people", version: 1, queries: { count: { input: z.object({}), output: z.number() } } });
const order: string[] = [];
let coordinator: ServerContext<any, any, any>["privacy"] | undefined;

// people is required by notes, so exports run people → notes and erasures notes → people.
const people = defineServerModule({
  contract: peopleContract,
  implement: { queries: { count: () => 0 } },
  setup(ctx) {
    ctx.privacy.handle("client", {
      export: (_call, id) => ({ person: id }),
      erase: (_call, _id, request) => {
        order.push("people");
        return { anonymized: 1, review: request.terms.map((t) => ({ what: "title", ref: "x", excerpt: t })) };
      },
    });
  },
});
const notes = defineServerModule({
  id: "notes",
  requires: [peopleContract],
  setup(ctx) {
    coordinator = ctx.privacy;
    ctx.privacy.handle("client", {
      // Encrypted data needs the caller's vault; the hook gets this module's own scope when there is one.
      export: (call) => ({ unlocked: call.vault !== undefined }),
      erase: () => {
        order.push("notes");
        return { removed: 2 };
      },
    });
    ctx.privacy.handle("user", { export: (_call, id) => ({ me: id }) });
  },
});

function setup(extra: { requirePrivacy?: boolean; modules?: unknown[] } = {}) {
  const sessions = new Map<string, Buffer>();
  const vaultFor = (sessionId: string): VaultHandle | undefined => {
    const dek = sessions.get(sessionId);
    return dek && { userId: 1, scope: (n: string) => createVaultScope(n, deriveScopeKeys(dek, n)), legacy: createLegacyScope(dek) };
  };
  const host = createServerHost({
    modules: (extra.modules ?? [notes, people]) as never,
    db: drizzle(new Database(":memory:")),
    vaultFor,
    requireVault: (_r, reply) => void reply.code(401).send({}),
    requirePrivacy: extra.requirePrivacy,
  });
  return { host, unlock: () => sessions.set("s1", generateDek()) };
}

describe("privacy hooks", () => {
  it("exports in dependency order, erases dependents first, and passes terms and the vault scope", async () => {
    const { unlock } = setup();
    const caller = { userId: 1, sessionId: "s1" };
    expect(coordinator!.subjects()).toEqual(["client", "user"]);
    expect(await coordinator!.run("export", caller, "client", 5)).toEqual([
      { module: "people", result: { person: 5 } },
      { module: "notes", result: { unlocked: false } },
    ]);
    unlock();
    expect((await coordinator!.run("export", caller, "client", 5))[1]).toEqual({ module: "notes", result: { unlocked: true } });
    order.length = 0;
    const erased = await coordinator!.run("erase", caller, "client", 5, { terms: ["Bára", " "] });
    expect(order).toEqual(["notes", "people"]);
    expect(erased).toEqual([
      { module: "notes", result: { removed: 2 } },
      { module: "people", result: { anonymized: 1, review: [{ what: "title", ref: "x", excerpt: "Bára" }] } },
    ]);
  });

  it("with requirePrivacy, refuses modules that have tables but say nothing about personal data", () => {
    const silent = defineServerModule({ id: "silent", schema: { t: sqliteTable("silent_t", { id: integer("id").primaryKey() }) } });
    expect(() => setup({ requirePrivacy: true, modules: [silent] })).toThrow(ModuleCompositionError);
    expect(() => setup({ requirePrivacy: false, modules: [silent] })).not.toThrow();
    const declared = defineServerModule({ id: "silent", schema: { t: sqliteTable("silent_t", { id: integer("id").primaryKey() }) }, setup: (ctx) => ctx.privacy.none("counters only") });
    expect(() => setup({ requirePrivacy: true, modules: [declared] })).not.toThrow();
  });
});
