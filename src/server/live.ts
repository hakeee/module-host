import websocket from "@fastify/websocket";
import type { VaultHandle } from "@hakeee/vault-service";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** What the browser receives on `/<prefix>/_live`. */
export type LiveMessage =
  | { readonly type: "event"; readonly contract: string; readonly event: string; readonly payload: unknown }
  /** A module's job list changed for this user - refetch `useJobs`. No job details travel. */
  | { readonly type: "jobs"; readonly module: string }
  /** This tab's vault session locked or unlocked. Sent on connect and on every change. */
  | { readonly type: "vault"; readonly unlocked: boolean };

/** A session's vault became unlocked or stopped being - e.g. from vault-service's `sessionCache.onChange`. */
export interface VaultChange {
  readonly sessionId: string;
  readonly userId: number;
  readonly unlocked: boolean;
}

/** Close code for a socket that was admitted without a session; the client waits before retrying. */
export const LIVE_CLOSE_VAULT_LOCKED = 4423;

interface LiveSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  on(event: "close", listener: () => void): void;
}

interface Who {
  readonly userId: number;
  readonly sessionId: string;
}

interface Entry {
  readonly who: Who;
  unlocked: boolean;
}

const OPEN = 1;

/**
 * One WebSocket per open tab, keyed to the user and session that opened
 * it. A socket can open while the vault is locked (when the host has
 * `requireCaller`); it then gets `{ type: "vault", unlocked }` on connect
 * and on every change, and module events and job updates only while
 * unlocked - they can carry decrypted content.
 */
export function createLiveHub(options: {
  vaultFor(sessionId: string): VaultHandle | undefined;
  heartbeatMs?: number;
  origins?: readonly string[];
}) {
  const sockets = new Map<LiveSocket, Entry>();
  const pending = new WeakMap<FastifyRequest, Who>();

  const isUnlocked = (who: Who) => {
    const vault = options.vaultFor(who.sessionId);
    return vault !== undefined && vault.userId === who.userId;
  };

  const send = (socket: LiveSocket, message: LiveMessage) => {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
  };

  /** Brings one socket's known state up to date, telling the tab if it changed. */
  const sync = (socket: LiveSocket, entry: Entry, unlocked = isUnlocked(entry.who)) => {
    if (entry.unlocked === unlocked) return;
    entry.unlocked = unlocked;
    send(socket, { type: "vault", unlocked });
  };

  return {
    publish(userId: number, message: LiveMessage): void {
      for (const [socket, entry] of sockets) {
        if (entry.who.userId !== userId) continue;
        sync(socket, entry);
        if (entry.unlocked) send(socket, message);
      }
    },

    /** A session locked or unlocked: tell its tabs now rather than at the next heartbeat. */
    vaultChanged(change: VaultChange): void {
      for (const [socket, entry] of sockets) {
        if (entry.who.sessionId !== change.sessionId) continue;
        // Re-check rather than trust the event: the session may belong to another user.
        sync(socket, entry);
      }
    },

    connectionCount(): number {
      return sockets.size;
    },

    async register(
      app: FastifyInstance,
      /** Who may open a socket: the host's `requireCaller` (logged in), or `requireVault` (unlocked) without one. */
      admit: (request: FastifyRequest, reply: FastifyReply) => Who | undefined,
    ): Promise<void> {
      // Reuse the app's own registration if it has one (it may need
      // websockets elsewhere, or `injectWS` in tests); otherwise bring it.
      if (!app.hasDecorator("websocketServer")) await app.register(websocket);

      const heartbeat = setInterval(() => {
        for (const [socket, entry] of sockets) {
          sync(socket, entry);
          if (socket.readyState === OPEN) socket.ping();
        }
      }, options.heartbeatMs ?? 30_000);
      heartbeat.unref?.();
      app.addHook("onClose", async () => {
        clearInterval(heartbeat);
        for (const socket of sockets.keys()) socket.close(1001, "server shutting down");
        sockets.clear();
      });

      app.get(
        "/_live",
        {
          websocket: true,
          preValidation: async (request, reply) => {
            // Browsers attach cookies to WebSocket handshakes and CORS doesn't
            // apply, so check Origin explicitly (cross-site WebSocket hijacking).
            if (options.origins && !options.origins.includes(String(request.headers.origin))) {
              return reply.code(403).send({ error: "origin not allowed" });
            }
            const who = admit(request, reply);
            if (!who) return reply;
            pending.set(request, { userId: who.userId, sessionId: who.sessionId });
          },
        },
        (socket, request) => {
          const who = pending.get(request);
          if (!who) {
            socket.close(LIVE_CLOSE_VAULT_LOCKED, "vault locked");
            return;
          }
          const live = socket as unknown as LiveSocket;
          const entry: Entry = { who, unlocked: isUnlocked(who) };
          sockets.set(live, entry);
          socket.on("close", () => sockets.delete(live));
          send(live, { type: "vault", unlocked: entry.unlocked });
        },
      );
    },
  };
}

export type LiveHub = ReturnType<typeof createLiveHub>;
