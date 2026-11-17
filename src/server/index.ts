import type { LegacyVaultScope, VaultHandle, VaultScope } from "@hakeee/vault-service";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  OperationError,
  assertModuleId,
  isContract,
  operationsOf,
  type AnyContract,
  type OperationDef,
  type OperationRef,
} from "../contract.js";
import { ModuleCompositionError, resolveModules, visibleContracts } from "../resolve.js";
import { ContractInputError, ContractValidationError, validate, type Input, type Output, type Schema } from "../standardSchema.js";
import { checkTables } from "./tables.js";

export { checkTables, tablesOf } from "./tables.js";

// --- the app's database type ------------------------------------------------

/**
 * Declare your app's Drizzle database type here, once:
 *
 * ```ts
 * import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
 * declare module "@hakeee/module-host/server" {
 *   interface Register { db: BetterSQLite3Database<any> }
 * }
 * ```
 *
 * `ctx.db` and `ServerHostOptions.db` then use *your* drizzle-orm's types.
 * Without it they'd use this package's copy, and when the two copies differ
 * (linked repos each install their own) their table and SQL types don't
 * mix - the queries in a module stop type-checking.
 */
// biome-ignore lint: an empty interface is the point - it's for augmentation
export interface Register {}

export type ModuleDb = Register extends { db: infer D } ? D : BetterSQLite3Database<any>;

// --- call contexts -------------------------------------------------------

/** Who a call is on behalf of. Enough to re-derive any module's own vault scope. */
export interface Caller {
  readonly userId: number;
  readonly sessionId: string;
}

/** What a module's handler gets: the caller, plus *its own* vault scope (named after the module id). */
export interface CallContext extends Caller {
  readonly vault: VaultScope;
}

/** For modules that opted into `legacyEncryption` - their tables predate vault scopes. */
export interface LegacyCallContext extends CallContext {
  readonly legacy: LegacyVaultScope;
}

export type CallContextFor<L extends boolean> = L extends true ? LegacyCallContext : CallContext;

/** Thrown when a call's session has no unlocked vault (in-process callers; HTTP gets a 423). */
export class ModuleVaultLockedError extends Error {
  constructor() {
    super("vault locked");
  }
}

// --- type plumbing --------------------------------------------------------

type Requirement = AnyServerModule | AnyContract;

type ContractOf<R> = R extends AnyContract ? R : R extends { readonly contract: infer C } ? (C extends AnyContract ? C : never) : never;

type Handler<O extends OperationDef, L extends boolean> = (
  call: CallContextFor<L>,
  input: Output<O["input"]>,
) => Promise<Input<O["output"]>> | Input<O["output"]>;

type HandlerMap<Ops, L extends boolean> = { readonly [K in keyof Ops]: Ops[K] extends OperationDef ? Handler<Ops[K], L> : never };

type SectionImpl<Name extends string, Ops, L extends boolean> = keyof Ops extends never
  ? { readonly [P in Name]?: Record<string, never> }
  : { readonly [P in Name]: HandlerMap<Ops, L> };

export type Implementation<C extends AnyContract, L extends boolean> = SectionImpl<"queries", C["queries"], L> &
  SectionImpl<"commands", C["commands"], L>;

type ClientOps<Ops> = {
  readonly [K in keyof Ops]: Ops[K] extends OperationDef
    ? (caller: Caller, input: Input<Ops[K]["input"]>) => Promise<Output<Ops[K]["output"]>>
    : never;
};

/** A typed, validated, in-process client for one contract. */
export interface Client<C extends AnyContract> {
  readonly queries: ClientOps<C["queries"]>;
  readonly commands: ClientOps<C["commands"]>;
}

type EventPayload<C extends AnyContract, E extends keyof C["events"]> = C["events"][E] extends { payload: infer S }
  ? S extends Schema
    ? S
    : never
  : never;

export interface ServerContext<C extends AnyContract | undefined, R extends readonly Requirement[], L extends boolean> {
  readonly id: string;
  /** The shared database (typed via `Register`). Touch only your own tables; reach others' data through contracts. */
  readonly db: ModuleDb;
  /** A client for a contract this module implements or requires. Anything else is a type error. */
  use<U extends ContractOf<R[number]>>(contract: U): Client<U>;
  /** Publishes one of this module's own events. Subscribers run before this resolves; their errors are logged, not thrown. */
  emit<E extends C extends AnyContract ? keyof C["events"] & string : never>(
    caller: Caller,
    event: E,
    payload: C extends AnyContract ? Input<EventPayload<C, E>> : never,
  ): Promise<void>;
  /** Subscribes to an event of this module's own contract or one it requires. */
  on<U extends ContractOf<R[number]> | (C extends AnyContract ? C : never), E extends keyof U["events"] & string>(
    contract: U,
    event: E,
    handler: (call: CallContextFor<L>, payload: Output<EventPayload<U, E>>) => Promise<void> | void,
  ): void;
  /** Adds Fastify routes under `/<prefix>/<module id>`. Prefer contract operations; use this for what doesn't fit (uploads, streaming). */
  routes(plugin: (app: FastifyInstance) => Promise<void> | void): void;
  /** For your own routes: this module's call context, or a 423 reply and undefined. */
  requireCall(request: FastifyRequest, reply: FastifyReply): CallContextFor<L> | undefined;
  /** This module's call context for a caller, e.g. a session id stored with a job. */
  callFor(caller: Caller): CallContextFor<L>;
}

export interface ServerModuleDef<C extends AnyContract | undefined, R extends readonly Requirement[], L extends boolean> {
  /** Defaults to the contract's id. Required for modules without a contract. */
  readonly id?: string;
  readonly contract?: C;
  /** Server modules (pulled in with this one) or bare contracts (someone else must implement them). */
  readonly requires?: R;
  /** The module's Drizzle schema (all its tables). Used for the isolation checks, not for migrating. */
  readonly schema?: Readonly<Record<string, unknown>>;
  /** Tables exempt from the `<id>_` naming rule because they predate the module. */
  readonly legacyTableNames?: readonly string[];
  /** drizzle-kit output folder; tracked in `__module_<id>_migrations`. */
  readonly migrationsFolder?: string;
  /** Exposes `call.legacy` (vault-service's legacy scope) for data written before scopes existed. */
  readonly legacyEncryption?: L;
  /** Handlers for every contract operation - an object, or built from the module's context (for `ctx.db`, `ctx.use`). */
  readonly implement?: C extends AnyContract ? Implementation<C, L> | ((ctx: ServerContext<C, R, L>) => Implementation<C, L>) : never;
  readonly setup?: (ctx: ServerContext<C, R, L>) => void;
}

export interface ServerModule<
  C extends AnyContract | undefined = AnyContract | undefined,
  R extends readonly Requirement[] = readonly Requirement[],
  L extends boolean = boolean,
> {
  readonly kind: "server-module";
  readonly id: string;
  readonly contract: C;
  readonly requires: R;
  readonly def: ServerModuleDef<C, R, L>;
}

// biome-ignore lint: the "any server module" bound
export type AnyServerModule = ServerModule<any, any, any>;

export function defineServerModule<
  const C extends AnyContract | undefined = undefined,
  const R extends readonly Requirement[] = readonly [],
  const L extends boolean = false,
>(
  def: ServerModuleDef<C, R, L> &
    (C extends AnyContract
      ? { readonly implement: Implementation<C, L> | ((ctx: ServerContext<C, R, L>) => Implementation<C, L>) }
      : { readonly id: string }),
): ServerModule<C, R, L> {
  const id = def.id ?? def.contract?.id;
  if (!id) throw new Error("a server module without a contract needs an id");
  assertModuleId(id);
  if (def.contract && def.contract.id !== id) {
    throw new Error(`server module "${id}" implements contract "${def.contract.id}" - ids must match`);
  }
  return { kind: "server-module", id, contract: def.contract as C, requires: (def.requires ?? []) as R, def };
}

// --- host -----------------------------------------------------------------

export interface UnlockedRequest {
  sessionId: string;
  userId: number;
  vault: VaultHandle;
}

export interface ServerHostOptions {
  /** The app's top-level modules; their requirements are pulled in. */
  modules: readonly AnyServerModule[];
  db: ModuleDb;
  /** Per-request vault gate - e.g. vault-service's `createRequireVault(sessionCache)`. Must reply itself when locked. */
  requireVault(request: FastifyRequest, reply: FastifyReply): UnlockedRequest | undefined;
  /** The vault for a session id - e.g. `sessionCache.getVault`. */
  vaultFor(sessionId: string): VaultHandle | undefined;
  /** Tables outside any module that modules may reference, e.g. `["user"]`. */
  sharedTables?: readonly string[];
  logError?: (error: unknown, message: string) => void;
}

interface Runtime {
  module: AnyServerModule;
  visible: Set<string>;
  routePlugins: ((app: FastifyInstance) => Promise<void> | void)[];
  handlers: Record<string, (call: CallContext, input: unknown) => unknown>;
}

type Subscriber = { runtime: Runtime; handler: (call: CallContext, payload: unknown) => Promise<void> | void };

export interface ServerHost {
  /** Resolved modules, requirements first. */
  readonly modules: readonly AnyServerModule[];
  /** Applies every module's migrations, in dependency order. Run after vault-service's, before the app's own. */
  migrate(): void;
  /** Fastify plugin mounting every module at `/<module id>` - register it under a prefix (e.g. `/m`) behind your auth hook. */
  routes(app: FastifyInstance): Promise<void>;
  /** An unrestricted client, for app code that isn't a module yet. */
  client<C extends AnyContract>(contract: C): Client<C>;
}

export function migrationsTableFor(moduleId: string): string {
  return `__module_${moduleId.replaceAll("-", "_")}_migrations`;
}

function migrateResolved(db: ModuleDb, modules: readonly AnyServerModule[]): void {
  for (const module of modules) {
    if (!module.def.migrationsFolder) continue;
    // The app's drizzle copy, not necessarily ours - same runtime shape.
    drizzleMigrate(db as unknown as BetterSQLite3Database<any>, { migrationsFolder: module.def.migrationsFolder, migrationsTable: migrationsTableFor(module.id) });
  }
}

/**
 * Applies the migrations of `modules` (and everything they require), in
 * dependency order - without building a host or touching the vault, for
 * migration scripts and test setup. `createServerHost(...).migrate()` does
 * the same.
 */
export function migrateModules(db: ModuleDb, modules: readonly AnyServerModule[]): void {
  migrateResolved(db, resolveModules(modules, "server"));
}

export function createServerHost(options: ServerHostOptions): ServerHost {
  const modules = resolveModules(options.modules, "server");
  const sharedTables = options.sharedTables ?? [];
  const logError = options.logError ?? ((error, message) => console.error(message, error));

  checkTables(
    modules.map((m) => ({ id: m.id, schema: m.def.schema, legacyTableNames: m.def.legacyTableNames, requires: m.requires })),
    sharedTables,
  );

  const runtimes = new Map<string, Runtime>();
  const providerOf = new Map<string, Runtime>();
  const subscribers = new Map<string, Subscriber[]>();

  const buildCall = (runtime: Runtime, caller: Caller, vault: VaultHandle): CallContext => {
    const base: CallContext = { userId: caller.userId, sessionId: caller.sessionId, vault: vault.scope(runtime.module.id) };
    if (!runtime.module.def.legacyEncryption) return base;
    const withLegacy: LegacyCallContext = { ...base, legacy: vault.legacy };
    return withLegacy;
  };

  const callFor = (runtime: Runtime, caller: Caller): CallContext => {
    const vault = options.vaultFor(caller.sessionId);
    if (!vault || vault.userId !== caller.userId) throw new ModuleVaultLockedError();
    return buildCall(runtime, caller, vault);
  };

  const invoke = async (provider: Runtime, op: OperationRef, call: CallContext, rawInput: unknown) => {
    const where = `${op.contractId}.${op.name}`;
    let input: unknown;
    try {
      input = await validate(op.input, rawInput, `${where} input`);
    } catch (error) {
      if (error instanceof ContractValidationError) throw new ContractInputError(error.message, error.issues);
      throw error;
    }
    const result = await provider.handlers[op.name]!(call, input);
    return validate(op.output, result, `${where} output`);
  };

  const clientFor = (contract: AnyContract): Client<AnyContract> => {
    const provider = providerOf.get(contract.id);
    if (!provider) throw new ModuleCompositionError(`no module implements contract "${contract.id}"`);
    const section = (ops: Record<string, OperationRef>) =>
      Object.fromEntries(
        Object.entries(ops).map(([name, op]) => [
          name,
          async (caller: Caller, input: unknown) => invoke(provider, op, callFor(provider, caller), input),
        ]),
      );
    return { queries: section(contract.queries), commands: section(contract.commands) } as unknown as Client<AnyContract>;
  };

  const emit = async (contract: AnyContract, event: string, caller: Caller, rawPayload: unknown) => {
    const ref = (contract.events as Record<string, { payload: Schema }>)[event];
    if (!ref) throw new Error(`contract "${contract.id}" has no event "${event}"`);
    const payload = await validate(ref.payload, rawPayload, `${contract.id}.${event} event`);
    for (const { runtime, handler } of subscribers.get(`${contract.id}.${event}`) ?? []) {
      try {
        await handler(callFor(runtime, caller), payload);
      } catch (error) {
        logError(error, `"${runtime.module.id}" failed handling ${contract.id}.${event}`);
      }
    }
  };

  for (const module of modules) {
    const runtime: Runtime = { module, visible: visibleContracts(module), routePlugins: [], handlers: {} };
    runtimes.set(module.id, runtime);
    if (module.contract) providerOf.set(module.contract.id, runtime);
  }

  for (const runtime of runtimes.values()) {
    const { module } = runtime;
    const assertVisible = (contract: AnyContract) => {
      if (!runtime.visible.has(contract.id)) {
        throw new ModuleCompositionError(`"${module.id}" uses contract "${contract.id}" without requiring it`);
      }
    };
    const ctx: ServerContext<AnyContract, readonly Requirement[], boolean> = {
      id: module.id,
      db: options.db,
      use(contract) {
        assertVisible(contract);
        return clientFor(contract) as never;
      },
      emit(caller, event, payload) {
        if (!module.contract) throw new Error(`"${module.id}" has no contract, so no events`);
        return emit(module.contract, event, caller, payload);
      },
      on(contract, event, handler) {
        assertVisible(contract);
        if (!(event in contract.events)) throw new Error(`contract "${contract.id}" has no event "${event}"`);
        const key = `${contract.id}.${event}`;
        subscribers.set(key, [...(subscribers.get(key) ?? []), { runtime, handler: handler as Subscriber["handler"] }]);
      },
      routes(plugin) {
        runtime.routePlugins.push(plugin);
      },
      requireCall(request, reply) {
        const unlocked = options.requireVault(request, reply);
        return unlocked ? (buildCall(runtime, unlocked, unlocked.vault) as never) : undefined;
      },
      callFor(caller) {
        return callFor(runtime, caller) as never;
      },
    };
    if (module.contract) {
      const given = typeof module.def.implement === "function" ? module.def.implement(ctx as never) : module.def.implement;
      const implement = (given ?? {}) as { queries?: Record<string, unknown>; commands?: Record<string, unknown> };
      const ops = operationsOf(module.contract);
      const handlers = { ...implement.queries, ...implement.commands };
      for (const name of Object.keys(ops)) {
        if (typeof handlers[name] !== "function") {
          throw new ModuleCompositionError(`"${module.id}" doesn't implement ${module.contract.id}.${name}`);
        }
      }
      for (const name of Object.keys(handlers)) {
        if (!(name in ops)) throw new ModuleCompositionError(`"${module.id}" implements unknown operation "${name}"`);
      }
      runtime.handlers = handlers as Runtime["handlers"];
    }
    module.def.setup?.(ctx as never);
  }

  return {
    modules,
    migrate() {
      migrateResolved(options.db, modules);
    },
    async routes(app) {
      app.get("/_manifest", async () => ({
        modules: modules.map((m) => ({ id: m.id, contract: m.contract ? { id: m.contract.id, version: m.contract.version } : null })),
      }));

      for (const runtime of runtimes.values()) {
        const { module } = runtime;
        await app.register(
          async (scope) => {
            if (module.contract) {
              const ops = operationsOf(module.contract);
              scope.post<{ Params: { op: string } }>("/rpc/:op", async (request, reply) => {
                const op = ops[request.params.op];
                if (!op) return reply.code(404).send({ error: "unknown operation" });
                const unlocked = options.requireVault(request, reply);
                if (!unlocked) return reply;
                try {
                  return await invoke(runtime, op, buildCall(runtime, unlocked, unlocked.vault), request.body ?? {});
                } catch (error) {
                  if (error instanceof ContractInputError) {
                    return reply.code(400).send({ error: error.message });
                  }
                  if (error instanceof OperationError) {
                    return reply.code(error.status).send({ error: error.message });
                  }
                  throw error;
                }
              });
            }
            for (const plugin of runtime.routePlugins) await plugin(scope);
          },
          { prefix: `/${module.id}` },
        );
      }
    },
    client(contract) {
      return clientFor(contract) as never;
    },
  };
}

export { isContract };
