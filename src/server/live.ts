import websocket from "@fastify/websocket";
import type { VaultHandle } from "@hakeee/vault-service";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** What the browser receives on `/<prefix>/_live`. */
export type LiveMessage =
  | { readonly type: "event"; readonly contract: string; readonly event: string; readonly payload: unknown }
  /** A module's job list changed for this user - refetch `useJobs`. No job details travel. */
  | { readonly type: "jobs"; readonly module: string };

/** Close code sent when a socket's vault session is gone; the client should wait for an unlock, not hammer reconnects. */
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

const OPEN = 1;

/**
 * One WebSocket per open tab, keyed to the user and vault session that
 * opened it. Live events go only to that user's sockets, and only while
 * the session's vault is still unlocked: a tab whose session locked gets
 * closed with `LIVE_CLOSE_VAULT_LOCKED` instead of receiving plaintext.
 */
export function createLiveHub(options: {
  vaultFor(sessionId: string): VaultHandle | undefined;
  heartbeatMs?: number;
  origins?: readonly string[];
}) {
  const sockets = new Map<LiveSocket, Who>();
  const pending = new WeakMap<FastifyRequest, Who>();

  const stillUnlocked = (who: Who) => {
    const vault = options.vaultFor(who.sessionId);
    return vault !== undefined && vault.userId === who.userId;
  };

  return {
    publish(userId: number, message: LiveMessage): void {
      const data = JSON.stringify(message);
      for (const [socket, who] of sockets) {
        if (who.userId !== userId) continue;
        if (!stillUnlocked(who)) {
          sockets.delete(socket);
          socket.close(LIVE_CLOSE_VAULT_LOCKED, "vault locked");
          continue;
        }
        if (socket.readyState === OPEN) socket.send(data);
      }
    },

    connectionCount(): number {
      return sockets.size;
    },

    async register(
      app: FastifyInstance,
      requireVault: (request: FastifyRequest, reply: FastifyReply) => Who | undefined,
    ): Promise<void> {
      // Reuse the app's own registration if it has one (it may need
      // websockets elsewhere, or `injectWS` in tests); otherwise bring it.
      if (!app.hasDecorator("websocketServer")) await app.register(websocket);

      const heartbeat = setInterval(() => {
        for (const [socket, who] of sockets) {
          if (!stillUnlocked(who)) {
            sockets.delete(socket);
            socket.close(LIVE_CLOSE_VAULT_LOCKED, "vault locked");
          } else if (socket.readyState === OPEN) {
            socket.ping();
          }
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
            const unlocked = requireVault(request, reply);
            if (!unlocked) return reply;
            pending.set(request, { userId: unlocked.userId, sessionId: unlocked.sessionId });
          },
        },
        (socket, request) => {
          const who = pending.get(request);
          if (!who) {
            socket.close(LIVE_CLOSE_VAULT_LOCKED, "vault locked");
            return;
          }
          sockets.set(socket as unknown as LiveSocket, who);
          socket.on("close", () => sockets.delete(socket as unknown as LiveSocket));
        },
      );
    },
  };
}

export type LiveHub = ReturnType<typeof createLiveHub>;
