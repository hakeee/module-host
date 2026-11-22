import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract } from "../contract.js";
import { OperationError } from "../index.js";
import { createServerHost, defineServerModule, type OperationEvent } from "./index.js";

const thingsContract = defineContract({
  id: "things",
  version: 1,
  queries: { get: { input: z.object({ id: z.number() }), output: z.number(), vault: false } },
  commands: {
    remove: { input: z.object({ id: z.number() }), output: z.object({}), vault: false },
    secret: { input: z.object({}), output: z.object({}), vault: false },
  },
});
const things = defineServerModule({
  contract: thingsContract,
  implement: {
    queries: { get: (_call, { id }) => id },
    commands: {
      remove: (_call, { id }) => {
        if (id === 404) throw new OperationError(404, "no such thing");
        if (id === 500) throw new Error("boom");
        return {};
      },
      secret: () => ({}),
    },
  },
});

async function setup(events: OperationEvent[]) {
  const host = createServerHost({
    modules: [things],
    db: drizzle(new Database(":memory:")),
    vaultFor: () => undefined,
    requireVault: (_request, reply) => void reply.code(423).send({ error: "vault locked" }),
    requireCaller: (request, reply) => (request.headers["x-user"] ? { userId: Number(request.headers["x-user"]), sessionId: "s" } : void reply.code(401).send({ error: "login required" })),
    authorize: (_caller, action) => action !== "things:secret",
    onOperation: (e) => void events.push(e),
    logError: () => {},
    live: false,
  });
  const app = Fastify();
  await app.register(host.routes, { prefix: "/m" });
  return app;
}

describe("onOperation", () => {
  it("reports each browser call with its outcome, and nothing for calls refused before the operation", async () => {
    const events: OperationEvent[] = [];
    const app = await setup(events);
    const call = (op: string, payload: object, user = "7") => app.inject({ method: "POST", url: `/m/things/rpc/${op}`, headers: user ? { "x-user": user } : {}, payload, remoteAddress: "10.0.0.5" });
    await call("get", { id: 1 });
    await call("remove", { id: 2 });
    await call("secret", {});
    await call("remove", { id: "x" });
    await call("remove", { id: 404 });
    await call("remove", { id: 500 });
    await call("remove", { id: 3 }, "");
    expect(events.map((e) => [e.action, e.kind, e.outcome, e.status])).toEqual([
      ["things:get", "query", "ok", 200],
      ["things:remove", "command", "ok", 200],
      ["things:secret", "command", "denied", 403],
      ["things:remove", "command", "invalid", 400],
      ["things:remove", "command", "not-found", 404],
      ["things:remove", "command", "error", 500],
    ]);
    expect(events[1]).toMatchObject({ caller: { userId: 7 }, input: { id: 2 }, ip: "10.0.0.5" });
  });
});
