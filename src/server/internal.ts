import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { OperationError, type AnyContract, type OperationRef } from "../contract.js";
import { ModuleCompositionError } from "../resolve.js";
import type { LiveMessage } from "./live.js";

/**
 * The internal channel between hosts in different processes (an API and a
 * worker, say). Every request carries a shared secret; it's for a private
 * network only and is mounted separately from the public, cookie-auth
 * routes.
 *
 * - `POST /rpc/:contract/:op` - call an operation of a module this host
 *   runs, on behalf of `{ caller, input }`. The caller's contract version
 *   travels in a header; a mismatch is a 409, not a silent misread.
 * - `POST /live` - publish a live message to this host's sockets (a
 *   worker relaying its events to the API, which holds the browsers).
 */

export const SECRET_HEADER = "x-module-secret";
export const VERSION_HEADER = "x-contract-version";

export function sameSecret(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || expected.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface RemoteDef {
  /** Where the other host's `internalRoutes` are mounted, e.g. `http://worker:3400/internal/m`. */
  readonly url: string;
  readonly secret: string;
  /** Contracts implemented over there; calls to them go over the wire. */
  readonly contracts: readonly AnyContract[];
}

export class ModuleRemoteError extends Error {}

/** Thrown in-process when the remote host reports the caller's vault locked. */
export const REMOTE_LOCKED = 423;

export function createRemoteInvoker(remote: RemoteDef, onLocked: () => never) {
  return async (contract: AnyContract, op: OperationRef, caller: { userId: number; sessionId: string }, input: unknown) => {
    let response: Response;
    try {
      response = await fetch(`${remote.url}/rpc/${contract.id}/${op.name}`, {
        method: "POST",
        headers: { "content-type": "application/json", [SECRET_HEADER]: remote.secret, [VERSION_HEADER]: String(contract.version) },
        body: JSON.stringify({ caller: { userId: caller.userId, sessionId: caller.sessionId }, input }),
      });
    } catch (error) {
      throw new ModuleRemoteError(`remote host for "${contract.id}" unreachable: ${(error as Error).message}`);
    }
    if (response.ok) return response.json();
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === REMOTE_LOCKED) onLocked();
    if (response.status === 409) throw new ModuleCompositionError(body.error ?? `contract "${contract.id}" version mismatch`);
    if (response.status === 401) throw new ModuleRemoteError(`remote host for "${contract.id}" rejected the secret`);
    throw new OperationError(response.status, body.error ?? `remote ${contract.id}.${op.name} failed`);
  };
}

export async function relayLive(relay: { url: string; secret: string }, userId: number, message: LiveMessage): Promise<void> {
  const response = await fetch(`${relay.url}/live`, {
    method: "POST",
    headers: { "content-type": "application/json", [SECRET_HEADER]: relay.secret },
    body: JSON.stringify({ userId, message }),
  });
  if (!response.ok) throw new ModuleRemoteError(`live relay failed: ${response.status}`);
}

export interface InternalHandlers {
  secret: string;
  invoke(contractId: string, opName: string, version: number, caller: { userId: number; sessionId: string }, input: unknown): Promise<unknown>;
  publish(userId: number, message: LiveMessage): void;
}

export function registerInternalRoutes(app: FastifyInstance, handlers: InternalHandlers): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!sameSecret(request.headers[SECRET_HEADER], handlers.secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.post<{ Params: { contract: string; op: string }; Body: { caller?: { userId?: unknown; sessionId?: unknown }; input?: unknown } }>(
    "/rpc/:contract/:op",
    async (request) => {
      const { caller, input } = request.body ?? {};
      if (typeof caller?.userId !== "number" || typeof caller.sessionId !== "string") {
        throw new OperationError(400, "caller { userId, sessionId } required");
      }
      const version = Number(request.headers[VERSION_HEADER]);
      return handlers.invoke(request.params.contract, request.params.op, version, { userId: caller.userId, sessionId: caller.sessionId }, input ?? {});
    },
  );

  app.post<{ Body: { userId?: unknown; message?: LiveMessage } }>("/live", async (request) => {
    const { userId, message } = request.body ?? {};
    if (typeof userId !== "number" || !message || (message.type !== "event" && message.type !== "jobs")) {
      throw new OperationError(400, "{ userId, message } required");
    }
    handlers.publish(userId, message);
    return { ok: true };
  });
}
