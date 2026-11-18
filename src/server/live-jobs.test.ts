import { createLegacyScope, createVaultScope, deriveScopeKeys, generateDek, type VaultHandle } from "@hakeee/vault-service";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract } from "../contract.js";
import { ModuleCompositionError } from "../resolve.js";
import { JOBS_TABLE, createServerHost, defineServerModule, type AnyServerModule, type JobEvent } from "./index.js";

// --- vault: sessions by id, via an `x-session` header over HTTP -------------

const sessions = new Map<string, { userId: number; dek: Buffer }>();
const vaultFor = (sessionId: string): VaultHandle | undefined => {
  const s = sessions.get(sessionId);
  return s && { userId: s.userId, scope: (n: string) => createVaultScope(n, deriveScopeKeys(s.dek, n)), legacy: createLegacyScope(s.dek) };
};
function unlock(sessionId: string, userId: number) {
  sessions.set(sessionId, { userId, dek: generateDek() });
  return { sessionId, userId };
}

function build(modules: readonly AnyServerModule[], extra: Partial<Parameters<typeof createServerHost>[0]> = {}) {
  const db = drizzle(new Database(":memory:"));
  const host = createServerHost({
    modules,
    db,
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
  host.migrate();
  return { host, db };
}

afterEach(() => sessions.clear());

// --- live updates -------------------------------------------------------------

const notesContract = defineContract({
  id: "notes",
  version: 1,
  queries: { list: { input: z.object({}), output: z.array(z.string()) } },
  events: {
    changed: { payload: z.object({ id: z.number() }), live: true, invalidates: ["list"] },
    audited: z.object({ id: z.number() }), // short form: server-side only
  },
});

let notesCtx: { emit(caller: unknown, event: string, payload: unknown): Promise<void> } | undefined;
const notes = defineServerModule({
  contract: notesContract,
  implement: { queries: { list: () => [] } },
  setup(ctx) {
    notesCtx = ctx as never;
  },
});

describe("live updates", () => {
  async function liveApp() {
    const { host } = build([notes], { live: { heartbeatMs: 60_000 } });
    const app = Fastify();
    await app.register(websocket); // at the root, so the test can use app.injectWS
    await app.register(host.routes, { prefix: "/m" });
    await app.ready();
    return { app, host };
  }

  /** Messages a socket receives; `vault` state messages separately, so event assertions stay simple. */
  function collect(ws: { on(e: "message", f: (d: Buffer) => void): void }, vault: unknown[] = []) {
    const got: unknown[] = [];
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      (message.type === "vault" ? vault : got).push(message);
    });
    return got;
  }

  /** Opens a socket and collects from the very first message (the initial vault state arrives right away). */
  async function open(app: Awaited<ReturnType<typeof liveApp>>["app"], headers: Record<string, string>) {
    const vault: unknown[] = [];
    let got: unknown[] = [];
    const ws = await app.injectWS("/m/_live", { headers }, { onInit: (socket) => void (got = collect(socket as never, vault)) });
    return { ws, got: () => got, vault };
  }

  it("refuses the socket while the vault is locked", async () => {
    const { app } = await liveApp();
    await expect(app.injectWS("/m/_live")).rejects.toThrow(/423/);
    await app.close();
  });

  it("refuses other origins when origins are configured", async () => {
    const { host } = build([notes], { live: { origins: ["https://app.test"] } });
    const app = Fastify();
    await app.register(websocket);
    await app.register(host.routes, { prefix: "/m" });
    await app.ready();
    unlock("a1", 1);
    await expect(app.injectWS("/m/_live", { headers: { "x-session": "a1", origin: "https://evil.test" } })).rejects.toThrow(/403/);
    const ok = await app.injectWS("/m/_live", { headers: { "x-session": "a1", origin: "https://app.test" } });
    ok.terminate();
    await app.close();
  });

  it("pushes live events to that user's sockets only, and never non-live ones", async () => {
    const { app, host } = await liveApp();
    const alice = unlock("a1", 1);
    unlock("b1", 2);
    const aliceWs = await app.injectWS("/m/_live", { headers: { "x-session": "a1" } });
    const bobWs = await app.injectWS("/m/_live", { headers: { "x-session": "b1" } });
    const aliceGot = collect(aliceWs);
    const bobGot = collect(bobWs);
    expect(host.liveConnectionCount()).toBe(2);

    await notesCtx!.emit(alice, "changed", { id: 7 });
    await notesCtx!.emit(alice, "audited", { id: 7 });
    await vi.waitFor(() => expect(aliceGot).toHaveLength(1));
    expect(aliceGot[0]).toEqual({ type: "event", contract: "notes", event: "changed", payload: { id: 7 } });
    expect(bobGot).toEqual([]);

    aliceWs.terminate();
    bobWs.terminate();
    await app.close();
  });

  it("keeps a socket open across a lock, holding events back and reporting the state", async () => {
    const { app } = await liveApp();
    const alice = unlock("a1", 1);
    const { ws, got, vault } = await open(app, { "x-session": "a1" });
    await vi.waitFor(() => expect(vault).toEqual([{ type: "vault", unlocked: true }]));

    sessions.delete("a1"); // the session locked
    unlock("a2", 1); // same user, another (unlocked) session emits
    await notesCtx!.emit({ userId: 1, sessionId: "a2" }, "changed", { id: 1 });
    await vi.waitFor(() => expect(vault).toHaveLength(2));
    expect(vault[1]).toEqual({ type: "vault", unlocked: false });
    expect(got()).toEqual([]);

    unlock("a1", 1);
    await notesCtx!.emit(alice, "changed", { id: 2 });
    await vi.waitFor(() => expect(got()).toHaveLength(1));
    expect(vault[2]).toEqual({ type: "vault", unlocked: true });
    expect(got()[0]).toMatchObject({ type: "event", payload: { id: 2 } });
    ws.terminate();
    await app.close();
  });

  it("with requireCaller, admits a locked tab and reports unlock and lock right away", async () => {
    const listeners = new Set<(c: { sessionId: string; userId: number; unlocked: boolean }) => void>();
    const changed = (c: { sessionId: string; userId: number; unlocked: boolean }) => listeners.forEach((l) => l(c));
    const { host } = build([notes], {
      live: { heartbeatMs: 60_000 },
      requireCaller(request, reply) {
        const sessionId = request.headers["x-session"] as string | undefined;
        if (!sessionId) {
          reply.code(401).send({ error: "login required" });
          return undefined;
        }
        return { userId: Number(request.headers["x-user"]), sessionId };
      },
      vaultEvents(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const app = Fastify();
    await app.register(websocket);
    await app.register(host.routes, { prefix: "/m" });
    await app.ready();

    await expect(app.injectWS("/m/_live")).rejects.toThrow(/401/);
    const vault: unknown[] = [];
    const ws = await app.injectWS("/m/_live", { headers: { "x-session": "c1", "x-user": "1" } }, { onInit: (s) => void collect(s as never, vault) });
    await vi.waitFor(() => expect(vault).toEqual([{ type: "vault", unlocked: false }]));

    unlock("c1", 1);
    changed({ sessionId: "c1", userId: 1, unlocked: true });
    await vi.waitFor(() => expect(vault).toHaveLength(2));
    sessions.delete("c1");
    changed({ sessionId: "c1", userId: 1, unlocked: false });
    changed({ sessionId: "other", userId: 1, unlocked: false }); // another session: not this tab's business
    await vi.waitFor(() => expect(vault).toHaveLength(3));
    expect(vault.slice(1)).toEqual([
      { type: "vault", unlocked: true },
      { type: "vault", unlocked: false },
    ]);

    ws.terminate();
    await app.close();
    expect(listeners.size).toBe(0); // unsubscribed on close
  });
});

// --- jobs ---------------------------------------------------------------------

const ran: { name: string; payload: unknown; scope: string; userId: number }[] = [];
let failTimes = 0;

const reports = defineServerModule({
  id: "reports",
  jobs: {
    build: z.object({ title: z.string(), year: z.number() }),
    flaky: z.object({}),
  },
  setup(ctx) {
    reportsCtx = ctx;
    ctx.jobs.handle("build", (call, payload) => {
      const year: number = payload.year; // typed from the job schema
      ran.push({ name: "build", payload: { ...payload, year }, scope: call.vault.name, userId: call.userId });
    });
    ctx.jobs.handle("flaky", () => {
      if (failTimes-- > 0) throw new RangeError("secret detail that must not be stored");
      ran.push({ name: "flaky", payload: {}, scope: "reports", userId: 0 });
    });

    // @ts-expect-error - not a declared job
    expect(() => ctx.jobs.handle("nope", () => {})).toThrow(ModuleCompositionError);
  },
});
let reportsCtx: typeof reports extends never ? never : any;

const other = defineServerModule({
  id: "other",
  jobs: { ping: z.object({}) },
  setup(ctx) {
    otherCtx = ctx;
    ctx.jobs.handle("ping", () => void ran.push({ name: "ping", payload: {}, scope: "other", userId: 0 }));
  },
});
let otherCtx: any;

describe("jobs", () => {
  afterEach(() => {
    ran.length = 0;
    failTimes = 0;
  });

  it("stores payloads encrypted with the module's scope, and runs them with its call context", async () => {
    const { host, db } = build([reports]);
    const alice = unlock("a1", 1);
    const id = await reportsCtx.jobs.enqueue(alice, "build", { title: "Very private title", year: 2026 });

    const row = db.$client.prepare(`SELECT * FROM ${JOBS_TABLE} WHERE id = ?`).get(id) as { payload: Buffer; status: string };
    expect(row.status).toBe("queued");
    expect(row.payload.toString("latin1")).not.toContain("Very private title");

    expect(await host.jobs.runDue()).toBe(1);
    expect(ran).toEqual([{ name: "build", payload: { title: "Very private title", year: 2026 }, scope: "reports", userId: 1 }]);
    expect((db.$client.prepare(`SELECT status FROM ${JOBS_TABLE} WHERE id = ?`).get(id) as { status: string }).status).toBe("done");
  });

  it("validates payloads and needs an unlocked caller to enqueue", async () => {
    build([reports]);
    const alice = unlock("a1", 1);
    await expect(reportsCtx.jobs.enqueue(alice, "build", { title: 3 })).rejects.toThrow(/reports job build/);
    await expect(reportsCtx.jobs.enqueue({ userId: 1, sessionId: "locked" }, "build", { title: "x", year: 1 })).rejects.toThrow("vault locked");
  });

  it("waits for the vault without spending attempts", async () => {
    const onJob = vi.fn<(e: JobEvent) => void>();
    const { host, db } = build([reports], { onJob });
    const alice = unlock("a1", 1);
    const id = await reportsCtx.jobs.enqueue(alice, "build", { title: "t", year: 1 });
    const saved = sessions.get("a1")!;
    sessions.delete("a1"); // locked (e.g. API restart) before the job ran

    const now = Date.now();
    expect(await host.jobs.runDue({ now })).toBe(1);
    expect(onJob).toHaveBeenLastCalledWith(expect.objectContaining({ type: "waiting-for-vault", id }));
    const row = db.$client.prepare(`SELECT status, attempts, run_at FROM ${JOBS_TABLE} WHERE id = ?`).get(id) as { status: string; attempts: number; run_at: number };
    expect(row).toMatchObject({ status: "queued", attempts: 0 });
    expect(row.run_at).toBeGreaterThan(now);

    sessions.set("a1", saved); // unlocked again
    expect(await host.jobs.runDue({ now: row.run_at })).toBe(1);
    expect(ran).toHaveLength(1);
  });

  it("retries with backoff, then fails recording only the error class", async () => {
    const onJob = vi.fn<(e: JobEvent) => void>();
    const logError = vi.fn();
    const { host, db } = build([reports], { onJob, logError });
    const alice = unlock("a1", 1);
    failTimes = 5;
    const id = await reportsCtx.jobs.enqueue(alice, "flaky", {}, { maxAttempts: 2 });

    let now = Date.now();
    await host.jobs.runDue({ now });
    expect(onJob).toHaveBeenLastCalledWith(expect.objectContaining({ type: "retry", error: "RangeError" }));
    expect(await host.jobs.runDue({ now })).toBe(0); // backing off
    now += 60_000;
    await host.jobs.runDue({ now });
    const row = db.$client.prepare(`SELECT status, attempts, error FROM ${JOBS_TABLE} WHERE id = ?`).get(id);
    expect(row).toEqual({ status: "failed", attempts: 2, error: "RangeError" });
    expect(logError).toHaveBeenCalledOnce();
  });

  it("only runs jobs of the host's own modules - a worker can host a subset", async () => {
    const shared = new Database(":memory:");
    const db = drizzle(shared);
    const opts = { db, vaultFor, requireVault: () => undefined };
    const api = createServerHost({ ...opts, modules: [reports, other] });
    api.migrate();
    const alice = unlock("a1", 1);
    await reportsCtx.jobs.enqueue(alice, "build", { title: "t", year: 1 });
    await otherCtx.jobs.enqueue(alice, "ping", {});

    const worker = createServerHost({ ...opts, modules: [other] });
    expect(await worker.jobs.runDue()).toBe(1);
    expect(ran.map((r) => r.name)).toEqual(["ping"]);
  });

  it("requeues jobs a crash left running, when the runner starts", async () => {
    const { host, db } = build([reports]);
    const alice = unlock("a1", 1);
    const id = await reportsCtx.jobs.enqueue(alice, "build", { title: "t", year: 1 });
    db.$client.prepare(`UPDATE ${JOBS_TABLE} SET status = 'running' WHERE id = ?`).run(id);

    const stop = host.jobs.start({ pollMs: 5 });
    await vi.waitFor(() => expect(ran).toHaveLength(1));
    stop();
  });

  it("refuses declared jobs without a handler", () => {
    const lazy = defineServerModule({ id: "lazy", jobs: { x: z.object({}) } });
    expect(() => build([lazy])).toThrow(/declares job "x" but never handles it/);
  });

  it("calls prepareVault before running, for remote vaults", async () => {
    const prepared: string[] = [];
    const { host } = build([reports], { prepareVault: async (sessionId) => void prepared.push(sessionId) });
    const alice = unlock("a1", 1);
    await reportsCtx.jobs.enqueue(alice, "build", { title: "t", year: 1 });
    await host.jobs.runDue();
    expect(prepared).toEqual(["a1"]);
  });
});
