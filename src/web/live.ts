import type { AnyContract, EventRef } from "../contract.js";
import { validate } from "../standardSchema.js";

export type LiveStatus = "idle" | "connecting" | "open" | "closed";

/** Mirrors the server's `LIVE_CLOSE_VAULT_LOCKED` (kept separate so the web entry never imports server code). */
const CLOSE_VAULT_LOCKED = 4423;

export interface LiveConnectOptions {
  /** Refetch one contract's queries - all of them when `query` is omitted. */
  invalidate(contractId: string, query?: string): void;
  /** After a reconnect: events may have been missed, so refetch everything live-capable. */
  onReconnect(contractIds: readonly string[]): void;
  /** The server reported this tab's vault locked or unlocked (on connect, and on every change). */
  onVault?(unlocked: boolean): void;
}

export interface LiveClient {
  /** Opens the socket (reference-counted); the returned function releases it. */
  connect(options: LiveConnectOptions): () => void;
  subscribe(contractId: string, event: string, listener: (payload: unknown) => void): () => void;
  status(): LiveStatus;
  subscribeStatus(listener: () => void): () => void;
}

export function createLiveClient(config: {
  url: string;
  contracts: ReadonlyMap<string, AnyContract>;
  WebSocketImpl?: typeof WebSocket;
}): LiveClient {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const statusListeners = new Set<() => void>();
  let status: LiveStatus = "idle";
  let socket: WebSocket | undefined;
  let users = 0;
  let current: LiveConnectOptions | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let everOpened = false;
  let vaultUnlocked: boolean | undefined;

  const setStatus = (next: LiveStatus) => {
    status = next;
    statusListeners.forEach((l) => l());
  };

  const liveContractIds = () =>
    [...config.contracts.values()]
      .filter((c) => Object.values(c.events as Record<string, EventRef>).some((e) => e.live))
      .map((c) => c.id);

  const handleMessage = async (raw: string) => {
    let message: { type?: string; contract?: string; event?: string; payload?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === "vault" && typeof (message as { unlocked?: unknown }).unlocked === "boolean") {
      const unlocked = (message as { unlocked: boolean }).unlocked;
      // Events aren't delivered while locked, so anything live may be stale.
      if (unlocked && vaultUnlocked === false) current?.onReconnect(liveContractIds());
      vaultUnlocked = unlocked;
      current?.onVault?.(unlocked);
      return;
    }
    if (message.type === "jobs" && typeof (message as { module?: unknown }).module === "string") {
      current?.invalidate((message as { module: string }).module, "_jobs");
      return;
    }
    if (message.type !== "event" || !message.contract || !message.event) return;
    const contract = config.contracts.get(message.contract);
    const ref = (contract?.events as Record<string, EventRef> | undefined)?.[message.event];
    if (!contract || !ref?.live) return; // not something this bundle knows about
    let payload: unknown;
    try {
      payload = await validate(ref.payload, message.payload, `${contract.id}.${ref.name} live event`);
    } catch (error) {
      console.error("module-host: dropped a live event that doesn't match its contract", error);
      return;
    }
    for (const query of ref.invalidates) current?.invalidate(contract.id, query);
    listeners.get(`${contract.id}.${ref.name}`)?.forEach((l) => l(payload));
  };

  const open = () => {
    const Impl = config.WebSocketImpl ?? globalThis.WebSocket;
    if (!Impl || users === 0) return;
    setStatus("connecting");
    const ws = new Impl(config.url);
    socket = ws;
    ws.onopen = () => {
      failures = 0;
      setStatus("open");
      if (everOpened) current?.onReconnect(liveContractIds());
      everOpened = true;
    };
    ws.onmessage = (event) => void handleMessage(String(event.data));
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = undefined;
      setStatus("closed");
      if (users === 0) return;
      failures += 1;
      // A locked vault won't fix itself in a second; anything else backs off 1s -> 30s.
      const delay = event.code === CLOSE_VAULT_LOCKED ? 10_000 : Math.min(1000 * 2 ** (failures - 1), 30_000);
      retryTimer = setTimeout(open, delay);
    };
  };

  return {
    connect(options) {
      users += 1;
      current = options;
      if (users === 1) open();
      return () => {
        users -= 1;
        if (users > 0) return;
        if (retryTimer) clearTimeout(retryTimer);
        const ws = socket;
        socket = undefined;
        ws?.close(1000, "done");
        everOpened = false;
        vaultUnlocked = undefined;
        failures = 0;
        setStatus("idle");
      };
    },
    subscribe(contractId, event, listener) {
      const key = `${contractId}.${event}`;
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => set.delete(listener);
    },
    status: () => status,
    subscribeStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
}
