import websocket from "@fastify/websocket";
import { createLegacyScope, createVaultScope, deriveScopeKeys, generateDek, type VaultHandle } from "@hakeee/vault-service";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OperationError, defineContract } from "../contract.js";
import { JobDeferredError, ModuleRemoteError, ModuleVaultLockedError, createServerHost, defineServerModule, type AnyServerModule } from "./index.js";

// Both "processes" share one vault here (in real life the worker's comes from createRemoteVault).
const sessions = new Map<string, { userId: number; dek: Buffer }>();
const vaultFor = (id: string): VaultHandle | undefined => {
  const s = sessions.get(id);
  return s && { userId: s.userId, scope: (n: string) => createVaultScope(n, deriveScopeKeys(s.dek, n)), legacy: createLegacyScope(s.dek) };
};
const unlock = (sessionId: string, userId: number) => {
  sessions.set(sessionId, { userId, dek: generateDek() });
  return { sessionId, userId };
};
const requireVault = (request: { headers: Record<string, unknown> }, reply: { code(n: number): { send(b: unknown): void } }) => {
  const sessionId = request.headers["x-session"] as string | undefined;
  const vault = sessionId ? vaultFor(sessionId) : undefined;
  if (!sessionId || !vault) {
    reply.code(423).send({ error: "vault locked" });
    return undefined;
  }
  return { sessionId, userId: vault.userId, vault };
};
const memoryDb = () => drizzle(new Database(":memory:"));
async function listen(app: FastifyInstance) {
  await app.listen({ port: 0, host: "127.0.0.1" });
  return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}

// --- an AI-like module, server-only operations -----------------------------------

const aiContract = defineContract({
  id: "ai",
  version: 1,
  commands: {
    complete: {
      input: z.object({ prompt: z.string().min(1) }),
      output: z.object({ text: z.string(), by: z.string() }),
      serverOnly: true,
    },
  },
  queries: { status: { input: z.object({}), output: z.object({ ok: z.boolean() }) } },
  events: { finished: { payload: z.object({ chars: z.number() }), live: true } },
});

const ai = defineServerModule({
  contract: aiContract,
  implement: (ctx) => ({
    commands: {
      complete: async (call, { prompt }) => {
        if (prompt === "boom") throw new OperationError(503, "model busy");
        await ctx.emit(call, "finished", { chars: prompt.length });
        return { text: prompt.toUpperCase(), by: `user ${call.userId} via ${call.vault.name}` };
      },
    },
    queries: { status: () => ({ ok: true }) },
  }),
});

// A journal that needs ai but doesn't install it - someone else (a remote) provides it.
const journalContract = defineContract({
  id: "journal",
  version: 1,
  commands: { summarize: { input: z.object({ text: z.string() }), output: z.object({ summary: z.string() }) } },
});
const journal = defineServerModule({
  contract: journalContract,
  requires: [aiContract],
  implement: (ctx) => ({
    commands: {
      summarize: async (call, { text }) => ({ summary: (await ctx.use(aiContract).commands.complete(call, { prompt: text })).text }),
    },
  }),
});

describe("server-only operations", () => {
  it("aren't served to browsers, but other modules can call them", async () => {
    const host = createServerHost({ modules: [ai], db: memoryDb(), vaultFor, requireVault, live: false });
    const app = Fastify();
    await app.register(host.routes, { prefix: "/m" });
    unlock("s", 1);
    const rpc = (op: string) => app.inject({ method: "POST", url: `/m/ai/rpc/${op}`, headers: { "x-session": "s" }, payload: { prompt: "hi" } });
    expect((await rpc("complete")).statusCode).toBe(404);
    expect((await rpc("status")).statusCode).toBe(200);
    expect(await host.client(aiContract).commands.complete({ userId: 1, sessionId: "s" }, { prompt: "hi" })).toMatchObject({ text: "HI" });
  });
});

describe("remote providers and the live relay", () => {
  const SECRET = "internal-secret";
  let workerApp: FastifyInstance;
  let apiApp: FastifyInstance;
  let workerUrl = "";
  let apiUrl = "";
  let api: ReturnType<typeof createServerHost>;

  beforeAll(async () => {
    // API: runs journal + the browsers' live sockets; ai lives in the worker.
    apiApp = Fastify();
    await apiApp.register(websocket);
    apiUrl = await listen(apiApp).then(async (url) => url); // reserve a port first...
    await apiApp.close();

    workerApp = Fastify();
    const worker = createServerHost({
      modules: [ai],
      db: memoryDb(),
      vaultFor,
      requireVault: () => undefined,
      live: false,
      internal: { secret: SECRET },
      liveRelay: { url: `${apiUrl}/internal/m`, secret: SECRET },
    });
    await workerApp.register(worker.internalRoutes, { prefix: "/internal/m" });
    workerUrl = await listen(workerApp);

    api = createServerHost({
      modules: [journal],
      db: memoryDb(),
      vaultFor,
      requireVault,
      internal: { secret: SECRET },
      remotes: [{ url: `${workerUrl}/internal/m`, secret: SECRET, contracts: [aiContract] }],
    });
    apiApp = Fastify();
    await apiApp.register(websocket);
    await apiApp.register(api.routes, { prefix: "/m" });
    await apiApp.register(api.internalRoutes, { prefix: "/internal/m" });
    await apiApp.listen({ port: Number(new URL(apiUrl).port), host: "127.0.0.1" });
  });
  afterAll(async () => {
    await workerApp.close();
    await apiApp.close();
  });
  afterEach(() => sessions.clear());

  it("calls a contract implemented in another process, with the caller and its own scope over there", async () => {
    const alice = unlock("a1", 7);
    expect(await api.client(journalContract).commands.summarize(alice, { text: "hello" })).toEqual({ summary: "HELLO" });
    // ...and the provider saw the right caller and used *its* scope:
    expect(await api.client(aiContract).commands.complete(alice, { prompt: "x" })).toEqual({ text: "X", by: "user 7 via ai" });
  });

  it("carries expected failures, locked vaults and validation across", async () => {
    const alice = unlock("a1", 7);
    await expect(api.client(aiContract).commands.complete(alice, { prompt: "boom" })).rejects.toMatchObject({ status: 503, message: "model busy" });
    await expect(api.client(aiContract).commands.complete({ userId: 7, sessionId: "gone" }, { prompt: "x" })).rejects.toBeInstanceOf(
      ModuleVaultLockedError,
    );
    await expect(api.client(aiContract).commands.complete(alice, { prompt: "" })).rejects.toThrow(/ai\.complete input/);
  });

  it("rejects wrong secrets and version mismatches", async () => {
    const alice = unlock("a1", 7);
    const wrongSecret = createServerHost({
      modules: [journal],
      db: memoryDb(),
      vaultFor,
      requireVault,
      live: false,
      remotes: [{ url: `${workerUrl}/internal/m`, secret: "nope", contracts: [aiContract] }],
    });
    await expect(wrongSecret.client(aiContract).commands.complete(alice, { prompt: "x" })).rejects.toBeInstanceOf(ModuleRemoteError);

    const aiV2 = defineContract({ ...{ id: "ai" as const, version: 2 as const }, commands: { complete: aiContract.commands.complete } });
    const builtForV2 = createServerHost({
      modules: [],
      db: memoryDb(),
      vaultFor,
      requireVault,
      live: false,
      remotes: [{ url: `${workerUrl}/internal/m`, secret: SECRET, contracts: [aiV2] }],
    });
    await expect(builtForV2.client(aiV2).commands.complete(alice, { prompt: "x" })).rejects.toThrow(/v2, this host implements v1/);
  });

  it("relays live events emitted in the worker to the API's sockets", async () => {
    unlock("a1", 7);
    const ws = await apiApp.injectWS("/m/_live", { headers: { "x-session": "a1" } });
    const got: unknown[] = [];
    ws.on("message", (d: Buffer) => got.push(JSON.parse(String(d))));
    await api.client(aiContract).commands.complete({ userId: 7, sessionId: "a1" }, { prompt: "abc" });
    await vi.waitFor(() => expect(got).toEqual([{ type: "event", contract: "ai", event: "finished", payload: { chars: 3 } }]));
    ws.terminate();
  });

  it("refuses a contract that's both installed and remote", () => {
    expect(() =>
      createServerHost({
        modules: [ai],
        db: memoryDb(),
        vaultFor,
        requireVault,
        live: false,
        remotes: [{ url: workerUrl, secret: SECRET, contracts: [aiContract] }],
      }),
    ).toThrow(/both installed here and listed as remote/);
  });
});

// --- schedules and job visibility ------------------------------------------------

const ran: { userId: number; payload: unknown }[] = [];
const tidy = defineServerModule({
  id: "tidy",
  jobs: { sweep: z.object({ deep: z.boolean() }) },
  schedules: { nightly: { job: "sweep", everyMs: 24 * 3600_000, payload: { deep: true } } },
  setup(ctx) {
    ctx.jobs.handle("sweep", (call, payload) => void ran.push({ userId: call.userId, payload }));
  },
});

describe("schedules", () => {
  afterEach(() => {
    ran.length = 0;
    sessions.clear();
  });

  it("enqueues once per active user per period, as that user", async () => {
    let active = [unlock("a1", 1), unlock("a2", 1), unlock("b1", 2)]; // user 1 has two tabs
    const host = createServerHost({ modules: [tidy], db: memoryDb(), vaultFor, requireVault, live: false, activeCallers: () => active });
    host.migrate();
    const t0 = Date.now();

    await host.jobs.runDue({ now: t0 });
    expect(ran.map((r) => r.userId).sort()).toEqual([1, 2]);
    expect(ran[0]!.payload).toEqual({ deep: true });

    await host.jobs.runDue({ now: t0 + 3600_000 }); // an hour later: not due
    expect(ran).toHaveLength(2);

    active = [active[2]!]; // only user 2 is around a day later
    await host.jobs.runDue({ now: t0 + 25 * 3600_000 });
    expect(ran.map((r) => r.userId).sort()).toEqual([1, 2, 2]);
  });

  it("refuses a schedule for an unknown job", () => {
    const bad = defineServerModule({
      id: "bad",
      jobs: { a: z.object({}) },
      schedules: { s: { job: "b" as "a", everyMs: 1 } },
      setup: (ctx) => ctx.jobs.handle("a", () => {}),
    });
    expect(() => createServerHost({ modules: [bad], db: memoryDb(), vaultFor, requireVault, live: false })).toThrow(/unknown job "b"/);
  });
});

describe("job visibility", () => {
  it("lists the caller's own jobs for a module - status only - and pushes 'jobs' live", async () => {
    let tidyCtx: any;
    const visible = defineServerModule({
      id: "visible",
      jobs: { work: z.object({ secret: z.string() }) },
      setup(ctx) {
        tidyCtx = ctx;
        ctx.jobs.handle("work", () => {});
      },
    });
    const host = createServerHost({ modules: [visible] as AnyServerModule[], db: memoryDb(), vaultFor, requireVault });
    host.migrate();
    const app = Fastify();
    await app.register(websocket);
    await app.register(host.routes, { prefix: "/m" });
    await app.ready();

    const alice = unlock("a1", 1);
    unlock("b1", 2);
    const ws = await app.injectWS("/m/_live", { headers: { "x-session": "a1" } });
    const got: unknown[] = [];
    ws.on("message", (d: Buffer) => got.push(JSON.parse(String(d))));

    await tidyCtx.jobs.enqueue(alice, "work", { secret: "do not show" });
    await tidyCtx.jobs.enqueue({ userId: 2, sessionId: "b1" }, "work", { secret: "other user" });
    await vi.waitFor(() => expect(got).toEqual([{ type: "jobs", module: "visible" }]));

    expect(tidyCtx.jobs.pendingCount(1)).toBe(1);
    expect(tidyCtx.jobs.pendingCount(1, "work")).toBe(1);
    expect(tidyCtx.jobs.pendingCount(3)).toBe(0);

    const res = await app.inject({ method: "GET", url: "/m/visible/_jobs", headers: { "x-session": "a1" } });
    const { jobs } = res.json();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: "work", status: "queued", attempts: 0, error: null });
    expect(JSON.stringify(jobs)).not.toContain("do not show");

    await host.jobs.runDue();
    expect(tidyCtx.jobs.pendingCount(1)).toBe(0);
    await vi.waitFor(() => expect(got).toHaveLength(2));
    ws.terminate();
    await app.close();
  });
});

describe("deferred jobs", () => {
  it("wait out a dependency's outage without spending attempts", async () => {
    let down = true;
    let runs = 0;
    let ctxRef: any;
    const flaky = defineServerModule({
      id: "flaky",
      jobs: { call: z.object({}) },
      setup(ctx) {
        ctxRef = ctx;
        ctx.jobs.handle("call", () => {
          runs += 1;
          if (down) throw new JobDeferredError(60_000, "dependency down");
        });
      },
    });
    const events: string[] = [];
    const db = memoryDb();
    const host = createServerHost({ modules: [flaky] as AnyServerModule[], db, vaultFor, requireVault, live: false, onJob: (e) => void events.push(e.type) });
    host.migrate();
    const caller = unlock("d1", 9);
    await ctxRef.jobs.enqueue(caller, "call", {});
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) await host.jobs.runDue({ now: t0 + i * 61_000 }); // ten outages' worth - far past 3 attempts
    expect(runs).toBe(10);
    expect(db.$client.prepare("SELECT status, attempts FROM __module_jobs").get()).toEqual({ status: "queued", attempts: 0 });
    down = false;
    await host.jobs.runDue({ now: t0 + 11 * 61_000 });
    expect(db.$client.prepare("SELECT status FROM __module_jobs").get()).toEqual({ status: "done" });
    expect(events.filter((e) => e === "deferred")).toHaveLength(10);
  });
});
