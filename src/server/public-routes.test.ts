import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract } from "../contract.js";
import { OperationError } from "../index.js";
import { createServerHost, defineServerModule } from "./index.js";

const notesContract = defineContract({
  id: "notes",
  version: 1,
  queries: { count: { input: z.object({}), output: z.number(), vault: false } },
});

// A feed module: no login, a token in the URL, and it reads through another module as the token's owner.
const feeds = defineServerModule({
  id: "feeds",
  requires: [notesContract],
  setup(ctx) {
    const notes = ctx.use(notesContract);
    ctx.publicRoutes((app) => {
      app.get<{ Params: { token: string } }>("/:token", async (request) => {
        if (request.params.token !== "secret") throw new OperationError(404, "no such feed");
        return { count: await notes.queries.count({ userId: 7, sessionId: "feed" }, {}) };
      });
    });
  },
});
const notes = defineServerModule({ contract: notesContract, implement: { queries: { count: (call) => call.userId * 10 } } });

async function setup(allowed: boolean) {
  const db = drizzle(new Database(":memory:"));
  const host = createServerHost({
    modules: [feeds, notes],
    db,
    vaultFor: () => undefined,
    requireVault: (_request, reply) => void reply.code(401).send({ error: "login required" }),
    requireCaller: (_request, reply) => void reply.code(401).send({ error: "login required" }),
    authorize: (_caller, action) => allowed || action !== "notes:count",
    publicRateLimit: { max: 3, windowMs: 60_000 },
    live: false,
  });
  const app = Fastify();
  await app.register(host.publicRoutes, { prefix: "/p" });
  await app.register(host.routes, { prefix: "/m" });
  return app;
}

describe("public routes", () => {
  it("serves without a login, acts as a user through IAM, and maps OperationError to its status", async () => {
    const app = await setup(true);
    const ok = await app.inject({ method: "GET", url: "/p/feeds/secret" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ count: 70 });
    expect((await app.inject({ method: "GET", url: "/p/feeds/wrong" })).statusCode).toBe(404);
    // Not under the authenticated mount.
    expect((await app.inject({ method: "GET", url: "/m/feeds/secret" })).statusCode).toBe(404);
  });

  it("stops when the user may no longer do it", async () => {
    const app = await setup(false);
    expect((await app.inject({ method: "GET", url: "/p/feeds/secret" })).statusCode).toBe(403);
  });

  it("rate-limits per IP", async () => {
    const app = await setup(true);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: "GET", url: "/p/feeds/secret" })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});
