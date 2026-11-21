import type { LegacyVaultScope, VaultHandle, VaultScope } from "@hakeee/vault-service";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  OperationError,
  assertModuleId,
  isContract,
  actionOf,
  actionsOf,
  operationsOf,
  runsLocked,
  resourcesOf,
  type ActionInfo,
  type AnyContract,
  type ResourceCheck,
  type ResourceInfo,
  type OperationDef,
  type OperationRef,
} from "../contract.js";
import { ModuleCompositionError, resolveModules, visibleContracts } from "../resolve.js";
import type { Caller, Client } from "../client.js";
import { ContractInputError, ContractValidationError, validate, type Input, type Output, type Schema } from "../standardSchema.js";
import { createRemoteInvoker, registerInternalRoutes, relayLive, type RemoteDef } from "./internal.js";
import { JOBS_TABLE, createJobStore, retryDelayMs, type JobRow, type JobStore, type RawSqlite } from "./jobs.js";
import { createLiveHub, type LiveHub, type LiveMessage, type VaultChange } from "./live.js";
import { checkTables } from "./tables.js";

export { checkTables, tablesOf } from "./tables.js";
export type { Caller, Client } from "../client.js";
export { JOBS_TABLE, retryDelayMs } from "./jobs.js";
export { LIVE_CLOSE_VAULT_LOCKED, type LiveMessage, type VaultChange } from "./live.js";
export { ModuleRemoteError, type RemoteDef } from "./internal.js";

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
/**
 * Thrown by a job handler for "not now" - a dependency is down (e.g. the
 * AI answers 503) rather than the job being broken. The job is requeued
 * `retryInMs` later *without* counting an attempt, so an outage of any
 * length doesn't exhaust its retries; it waits, like a locked vault.
 */
export class JobDeferredError extends Error {
  constructor(
    readonly retryInMs: number,
    message = "deferred",
  ) {
    super(message);
  }
}

export class ModuleVaultLockedError extends Error {
  constructor() {
    super("vault locked");
  }
}

// --- type plumbing --------------------------------------------------------

type Requirement = AnyServerModule | AnyContract;

type ContractOf<R> = R extends AnyContract ? R : R extends { readonly contract: infer C } ? (C extends AnyContract ? C : never) : never;

/** `vault: false` operations get only the caller - there's no vault scope to hand them. */
type CallFor<O extends OperationDef, L extends boolean> = O extends { readonly vault: false } ? Caller : CallContextFor<L>;

type Handler<O extends OperationDef, L extends boolean> = (
  call: CallFor<O, L>,
  input: Output<O["input"]>,
) => Promise<Input<O["output"]>> | Input<O["output"]>;

type HandlerMap<Ops, L extends boolean> = { readonly [K in keyof Ops]: Ops[K] extends OperationDef ? Handler<Ops[K], L> : never };

type SectionImpl<Name extends string, Ops, L extends boolean> = keyof Ops extends never
  ? { readonly [P in Name]?: Record<string, never> }
  : { readonly [P in Name]: HandlerMap<Ops, L> };

export type Implementation<C extends AnyContract, L extends boolean> = SectionImpl<"queries", C["queries"], L> &
  SectionImpl<"commands", C["commands"], L>;


type EventPayload<C extends AnyContract, E extends keyof C["events"]> = C["events"][E] extends { payload: infer S }
  ? S extends Schema
    ? S
    : never
  : never;

/** A module's job types: name -> payload schema. Private to the module (others trigger work via commands/events). */
export type JobDefs = Readonly<Record<string, Schema>>;

export interface EnqueueOptions {
  /** Run no earlier than this many ms from now. */
  delayMs?: number;
  /** Attempts before the job is marked failed. Default 3. */
  maxAttempts?: number;
}

export interface ModuleJobs<J extends JobDefs, L extends boolean> {
  /** The handler for one of this module's job types. Every declared job needs exactly one. */
  handle<N extends keyof J & string>(name: N, handler: (call: CallContextFor<L>, payload: Output<J[N]>) => Promise<void> | void): void;
  /**
   * Queues a job on behalf of `caller`. The payload is validated, then
   * encrypted with this module's vault scope before it's stored - so the
   * caller's vault must be unlocked. Returns the job id.
   */
  enqueue<N extends keyof J & string>(caller: Caller, name: N, payload: Input<J[N]>, options?: EnqueueOptions): Promise<number>;
  /** How many of this module's jobs for `userId` are queued or running (optionally of one type). */
  pendingCount(userId: number, name?: keyof J & string): number;
}

/**
 * GDPR plumbing: each module says how to export and how to erase what it
 * holds about one data subject (`"user"`, or an app-defined type such as
 * `"client"`), and a coordinating module runs them all with
 * `ctx.privacy.run`. Hooks get the requesting caller (with a vault scope
 * when the request runs unlocked) and work on the module's own tables.
 */
export interface PrivacyHooks {
  /** JSON-safe data about the subject (left out of the result when undefined). */
  export?(call: PrivacyCall, subjectId: number, request: PrivacyRequest): unknown;
  /** Removes or anonymises what the module holds about the subject, and says what it did. */
  erase?(call: PrivacyCall, subjectId: number, request: PrivacyRequest): ErasureReport | void | Promise<ErasureReport | void>;
}
/** The requesting caller; `vault` is this module's own scope when the request has one (unlocked). */
export type PrivacyCall = Caller & { readonly vault?: VaultScope };
export interface PrivacyRequest {
  /** Words that identify the subject (a name), for finding them in free text the module can't erase by id. */
  readonly terms: readonly string[];
  /** The coordinator's id for this request, for hooks whose part arrives later (e.g. data only its owner can decrypt). */
  readonly id?: string;
}
export interface ErasureReport {
  readonly removed?: number;
  readonly anonymized?: number;
  /** Kept on purpose (e.g. accounting records), with why. */
  readonly kept?: readonly { count: number; why: string }[];
  /** Free text that mentions the subject, for a person to review. */
  readonly review?: readonly { what: string; ref: string; excerpt: string }[];
}
export interface PrivacyResult<T> {
  readonly module: string;
  readonly result: T;
}

export interface ServerContext<
  C extends AnyContract | undefined,
  R extends readonly Requirement[],
  L extends boolean,
  J extends JobDefs = {},
> {
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
  /** GDPR export and erasure hooks (see `PrivacyHooks`), and running everyone's. */
  readonly privacy: {
    /** This module's hooks for one subject type. */
    handle(subject: string, hooks: PrivacyHooks): void;
    /** Declares that this module holds no personal data (checked at boot with the host's `requirePrivacy`). */
    none(reason: string): void;
    /** Every module's hook for the subject: exports in dependency order, erasures dependents first. */
    run(kind: "export", call: Caller, subject: string, subjectId: number, request?: Partial<PrivacyRequest>): Promise<PrivacyResult<unknown>[]>;
    run(kind: "erase", call: Caller, subject: string, subjectId: number, request?: Partial<PrivacyRequest>): Promise<PrivacyResult<ErasureReport>[]>;
    /** Subject types some module handles. */
    subjects(): string[];
  };
  /** Adds Fastify routes under `/<prefix>/<module id>`. Prefer contract operations; use this for what doesn't fit (uploads, streaming). */
  routes(plugin: (app: FastifyInstance) => Promise<void> | void): void;
  /**
   * Adds Fastify routes reachable **without a login**, under the host's
   * `publicRoutes` mount (`/<public prefix>/<module id>`): calendar feeds,
   * webhooks, booking pages. The module authenticates each request itself
   * (a secret token, a signature). Rate-limited per IP by the host. To act
   * as a user, call operations with `{ userId, sessionId }` (only `vault:
   * false` ones work without a session); IAM checks them as usual.
   */
  publicRoutes(plugin: (app: FastifyInstance) => Promise<void> | void): void;
  /**
   * Whether `caller` may perform `action` (always true without the host's
   * `authorize`). For custom routes and declared actions, and with a
   * `resource` (`contract.resources.client.of(id, attributes)`) for one
   * record, inside operations that declare `resource`.
   */
  can(caller: Caller, action: string, resource?: ResourceCheck): Promise<boolean>;
  /** The items `caller` may perform `action` on, each checked as the record `toResource` names. Order kept. */
  filter<T>(caller: Caller, action: string, items: readonly T[], toResource: (item: T) => ResourceCheck): Promise<T[]>;
  /** Every action the installed modules define - e.g. for a policy editor. */
  actions(): readonly ActionInfo[];
  /** Every resource type the installed modules define. */
  resources(): readonly ResourceInfo[];
  /** For your own routes: this module's call context, or a 423 reply and undefined. */
  requireCall(request: FastifyRequest, reply: FastifyReply): CallContextFor<L> | undefined;
  /** This module's call context for a caller, e.g. a session id stored with a job. */
  callFor(caller: Caller): CallContextFor<L>;
  /** Background jobs declared in the module's `jobs`. */
  readonly jobs: ModuleJobs<J, L>;
}

export interface ServerModuleDef<
  C extends AnyContract | undefined,
  R extends readonly Requirement[],
  L extends boolean,
  J extends JobDefs = {},
> {
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
  readonly implement?: C extends AnyContract ? Implementation<C, L> | ((ctx: ServerContext<C, R, L, J>) => Implementation<C, L>) : never;
  /** Background job types (name -> payload schema); handlers are registered in `setup` with `ctx.jobs.handle`. */
  readonly jobs?: J;
  /**
   * Periodic jobs, per user: every `everyMs`, each user with an unlocked
   * session (host option `activeCallers`) gets `job` enqueued once, as
   * them. A user who isn't around catches up on their next unlock.
   */
  readonly schedules?: Readonly<Record<string, { readonly job: keyof J & string; readonly everyMs: number; readonly payload?: unknown }>>;
  readonly setup?: (ctx: ServerContext<C, R, L, J>) => void;
}

export interface ServerModule<
  C extends AnyContract | undefined = AnyContract | undefined,
  R extends readonly Requirement[] = readonly Requirement[],
  L extends boolean = boolean,
  J extends JobDefs = JobDefs,
> {
  readonly kind: "server-module";
  readonly id: string;
  readonly contract: C;
  readonly requires: R;
  readonly def: ServerModuleDef<C, R, L, J>;
}

// biome-ignore lint: the "any server module" bound
export type AnyServerModule = ServerModule<any, any, any, any>;

export function defineServerModule<
  const C extends AnyContract | undefined = undefined,
  const R extends readonly Requirement[] = readonly [],
  const L extends boolean = false,
  const J extends JobDefs = {},
>(
  def: ServerModuleDef<C, R, L, J> &
    (C extends AnyContract
      ? { readonly implement: Implementation<C, L> | ((ctx: ServerContext<C, R, L, J>) => Implementation<C, L>) }
      : { readonly id: string }),
): ServerModule<C, R, L, J> {
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
  /**
   * Who's calling, needing only a login - e.g. vault-service's
   * `createRequireCaller(...)`. Must reply itself when there's no login.
   * Required for `vault: false` operations; with it, the live socket also
   * opens while the vault is locked and reports lock/unlock to the tab.
   */
  requireCaller?(request: FastifyRequest, reply: FastifyReply): Caller | undefined;
  /**
   * Subscribes to vault lock/unlock - e.g. vault-service's
   * `sessionCache.onChange`. Lets the live socket tell a tab right away;
   * without it, the socket's heartbeat notices (every `live.heartbeatMs`).
   */
  vaultEvents?(listener: (change: VaultChange) => void): () => void;
  /**
   * Authorization for every operation call - from the browser, from another
   * module in-process, over the internal channel - and every job run, as
   * the calling user. `action` is `module:operation` (or `module:job`).
   * A denied call fails with `OperationError(403)`. Without it, everything
   * is allowed. The built-in IAM module (`@hakeee/module-host/iam/server`)
   * provides one.
   */
  authorize?(caller: Caller, action: string, resource?: ResourceCheck): boolean | Promise<boolean>;
  /** Actions checked outside the modules (e.g. vault-service's self-service ones), so `actions()` and policy editors list them. */
  extraActions?: readonly ActionInfo[];
  /** Tables outside any module that modules may reference, e.g. `["user"]`. */
  sharedTables?: readonly string[];
  logError?: (error: unknown, message: string) => void;
  /**
   * Live updates over WebSocket at `<prefix>/_live` (default on). Needs
   * `@fastify/websocket` installed. Set `origins` to your web app's origins:
   * browsers send cookies with WebSocket handshakes and CORS doesn't apply.
   */
  live?: false | { heartbeatMs?: number; origins?: readonly string[] };
  /**
   * Called before a job runs, with its vault session - for processes whose
   * `vaultFor` is backed by a remote vault that must fetch keys first (see
   * DESIGN.md "Background jobs").
   */
  prepareVault?: (sessionId: string) => Promise<void>;
  /** Observability for the job runner - e.g. log jobs waiting on a locked vault. */
  onJob?: (event: JobEvent) => void;
  /** Who's around right now - drives `schedules`. E.g. vault-service's `sessionCache.unlockedSessions()`. */
  activeCallers?: () => readonly Caller[];
  /** Serve this host's operations to other processes at `internalRoutes` (mounted by you, private network only). */
  internal?: { secret: string };
  /** Contracts implemented by other processes; `ctx.use` calls to them go over the internal channel. */
  remotes?: readonly RemoteDef[];
  /** Forward live messages to the host that holds the browsers' sockets (a worker -> the API). */
  liveRelay?: { url: string; secret: string };
  /**
   * Boot check for GDPR: every module with tables must register privacy
   * hooks (`ctx.privacy.handle`) or say it holds no personal data
   * (`ctx.privacy.none`). Off by default.
   */
  requirePrivacy?: boolean;
  /** Per-IP limit for `publicRoutes` (default 120 requests a minute); over it, a 429. */
  publicRateLimit?: { max: number; windowMs: number };
}

export interface JobEvent {
  readonly type: "done" | "retry" | "failed" | "waiting-for-vault" | "deferred";
  readonly id: number;
  readonly module: string;
  readonly name: string;
  readonly sessionId: string;
  /** The error's class name only - never its message, which could echo decrypted content. */
  readonly error?: string;
}

export interface JobRunner {
  /** Runs due jobs one at a time until none are left (or `limit` ran). Returns how many ran. */
  runDue(options?: { now?: number; limit?: number }): Promise<number>;
  /** Polls for due jobs until the returned function is called. Requeues jobs a crash left `running`. */
  start(options?: { pollMs?: number }): () => void;
}

interface Runtime {
  module: AnyServerModule;
  visible: Set<string>;
  routePlugins: ((app: FastifyInstance) => Promise<void> | void)[];
  publicRoutePlugins: ((app: FastifyInstance) => Promise<void> | void)[];
  privacy: Map<string, PrivacyHooks>;
  privacyNone?: string;
  handlers: Record<string, (call: CallContext, input: unknown) => unknown>;
  jobHandlers: Record<string, (call: CallContext, payload: unknown) => Promise<void> | void>;
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
  /** Runs this host's modules' background jobs (only theirs - a worker process can host a subset). */
  readonly jobs: JobRunner;
  /** Every action the installed modules define. */
  actions(): readonly ActionInfo[];
  /** Every resource type the installed modules define. */
  resources(): readonly ResourceInfo[];
  /** Open live-update sockets (for tests and diagnostics). */
  liveConnectionCount(): number;
  /** The internal channel (needs `internal.secret`): mount at a private prefix, outside your cookie-auth routes. */
  internalRoutes(app: FastifyInstance): Promise<void>;
  /**
   * Fastify plugin with every module's `ctx.publicRoutes`, at `/<module id>`.
   * Mount it under its own prefix (e.g. `/p`) **outside** your auth hook.
   */
  publicRoutes(app: FastifyInstance): Promise<void>;
}

export interface JobSummary {
  id: number;
  name: string;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export function migrationsTableFor(moduleId: string): string {
  return `__module_${moduleId.replaceAll("-", "_")}_migrations`;
}

const SCHEDULES_TABLE = "__module_schedules";
const SCHEDULES_DDL = `
CREATE TABLE IF NOT EXISTS ${SCHEDULES_TABLE} (
  module TEXT NOT NULL,
  name TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  last_run_at INTEGER NOT NULL,
  PRIMARY KEY (module, name, user_id)
);`;

function rawSqlite(db: ModuleDb): RawSqlite {
  const client = (db as unknown as { $client?: RawSqlite }).$client;
  if (!client) throw new Error("module-host: the database must be a drizzle better-sqlite3 instance");
  return client;
}

function migrateResolved(db: ModuleDb, modules: readonly AnyServerModule[]): void {
  if (modules.some((m) => Object.keys(m.def.jobs ?? {}).length > 0)) createJobStore(rawSqlite(db)).ensureTable();
  if (modules.some((m) => Object.keys(m.def.schedules ?? {}).length > 0)) rawSqlite(db).exec(SCHEDULES_DDL);
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
  const remoteContracts = (options.remotes ?? []).flatMap((r) => r.contracts);
  const modules = resolveModules(options.modules, "server", { requireProviders: true, externalContracts: remoteContracts });
  const sharedTables = options.sharedTables ?? [];
  const logError = options.logError ?? ((error, message) => console.error(message, error));

  checkTables(
    modules.map((m) => ({ id: m.id, schema: m.def.schema, legacyTableNames: m.def.legacyTableNames, requires: m.requires })),
    sharedTables,
  );

  const runtimes = new Map<string, Runtime>();
  const providerOf = new Map<string, Runtime>();
  const subscribers = new Map<string, Subscriber[]>();
  const live: LiveHub | undefined =
    options.live === false
      ? undefined
      : createLiveHub({ vaultFor: options.vaultFor, heartbeatMs: options.live?.heartbeatMs, origins: options.live?.origins });
  const jobModules = modules.filter((m) => Object.keys(m.def.jobs ?? {}).length > 0).map((m) => m.id);
  let jobStore: JobStore | undefined;
  const jobs = () => (jobStore ??= createJobStore(rawSqlite(options.db)));

  const publishLive = (userId: number, message: LiveMessage) => {
    live?.publish(userId, message);
    if (options.liveRelay) {
      relayLive(options.liveRelay, userId, message).catch((error) => logError(error, "module-host: live relay failed"));
    }
  };

  const remoteInvokers = new Map<string, ReturnType<typeof createRemoteInvoker>>();
  for (const remote of options.remotes ?? []) {
    const invoker = createRemoteInvoker(remote, () => {
      throw new ModuleVaultLockedError();
    });
    for (const contract of remote.contracts) {
      if (modules.some((m) => m.contract?.id === contract.id)) {
        throw new ModuleCompositionError(`contract "${contract.id}" is both installed here and listed as remote`);
      }
      remoteInvokers.set(contract.id, invoker);
    }
  }

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

  /** The context an operation's handler gets: just the caller for `vault: false`, else the vault scope (or a locked error). */
  const callForOp = (runtime: Runtime, op: OperationRef, caller: Caller): CallContext =>
    runsLocked(op) ? ({ userId: caller.userId, sessionId: caller.sessionId } as CallContext) : callFor(runtime, caller);

  const can = async (caller: Caller, action: string, resource?: ResourceCheck) =>
    options.authorize ? await options.authorize(caller, action, resource) : true;
  const filter = async <T>(caller: Caller, action: string, items: readonly T[], toResource: (item: T) => ResourceCheck) => {
    const allowed = await Promise.all(items.map((item) => can(caller, action, toResource(item))));
    return items.filter((_, i) => allowed[i]);
  };
  const assertAllowed = async (caller: Caller, action: string) => {
    if (!(await can(caller, action))) throw new OperationError(403, `not allowed: ${action}`);
  };

  const invoke = async (provider: Runtime, op: OperationRef, call: CallContext, rawInput: unknown) => {
    const where = `${op.contractId}.${op.name}`;
    await assertAllowed(call, actionOf(op));
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
    const remote = remoteInvokers.get(contract.id);
    if (remote) {
      const section = (ops: Record<string, OperationRef>) =>
        Object.fromEntries(
          Object.entries(ops).map(([name, op]) => [
            name,
            async (caller: Caller, input: unknown) => {
              const where = `${contract.id}.${name}`;
              const valid = await validate(op.input, input, `${where} input`);
              return validate(op.output, await remote(contract, op, caller, valid), `${where} output`);
            },
          ]),
        );
      return { queries: section(contract.queries), commands: section(contract.commands) } as unknown as Client<AnyContract>;
    }
    const provider = providerOf.get(contract.id);
    if (!provider) throw new ModuleCompositionError(`no module implements contract "${contract.id}"`);
    const section = (ops: Record<string, OperationRef>) =>
      Object.fromEntries(
        Object.entries(ops).map(([name, op]) => [
          name,
          async (caller: Caller, input: unknown) => invoke(provider, op, callForOp(provider, op, caller), input),
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
    if ((ref as { live?: boolean }).live) {
      publishLive(caller.userId, { type: "event", contract: contract.id, event, payload });
    }
  };

  async function enqueueFor(runtime: Runtime, caller: Caller, name: string, payload: unknown, enqueueOptions: EnqueueOptions, at = Date.now()) {
    const { module } = runtime;
    const schema = (module.def.jobs ?? {})[name];
    if (!schema) throw new Error(`"${module.id}" has no job "${name}"`);
    const valid = await validate(schema, payload, `${module.id} job ${name}`);
    const call = callFor(runtime, caller);
    const jobId = jobs().insert({
      module: module.id,
      name,
      userId: caller.userId,
      sessionId: caller.sessionId,
      payload: call.vault.encryptString(`job:${name}`, JSON.stringify(valid)),
      maxAttempts: enqueueOptions.maxAttempts ?? 3,
      runAt: at + (enqueueOptions.delayMs ?? 0),
    });
    publishLive(caller.userId, { type: "jobs", module: module.id });
    return jobId;
  }

  if (!options.requireCaller) {
    for (const module of modules) {
      const locked = Object.values(module.contract ? operationsOf(module.contract) : {}).find(runsLocked);
      if (locked) {
        throw new ModuleCompositionError(
          `${locked.contractId}.${locked.name} has vault: false, which needs the host's requireCaller option`,
        );
      }
    }
  }

  const allActions: ActionInfo[] = modules.flatMap((m) => [
    ...(m.contract ? actionsOf(m.contract) : []),
    ...Object.keys(m.def.jobs ?? {}).map((name) => ({ action: `${m.id}:${name}`, kind: "job" as const })),
  ]).concat(options.extraActions ?? []);
  const allResources: ResourceInfo[] = modules.flatMap((m) => (m.contract ? resourcesOf(m.contract) : []));

  for (const module of modules) {
    const runtime: Runtime = { module, visible: visibleContracts(module), routePlugins: [], publicRoutePlugins: [], privacy: new Map(), handlers: {}, jobHandlers: {} };
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
      publicRoutes(plugin) {
        runtime.publicRoutePlugins.push(plugin);
      },
      privacy: {
        handle(subject, hooks) {
          if (runtime.privacy.has(subject)) throw new ModuleCompositionError(`"${module.id}" handles privacy subject "${subject}" twice`);
          runtime.privacy.set(subject, hooks);
        },
        none(reason) {
          runtime.privacyNone = reason;
        },
        run: runPrivacy as never,
        subjects: () => [...new Set([...runtimes.values()].flatMap((r) => [...r.privacy.keys()]))].sort(),
      },
      can,
      filter,
      actions: () => allActions,
      resources: () => allResources,
      requireCall(request, reply) {
        const unlocked = options.requireVault(request, reply);
        return unlocked ? (buildCall(runtime, unlocked, unlocked.vault) as never) : undefined;
      },
      callFor(caller) {
        return callFor(runtime, caller) as never;
      },
      jobs: {
        handle(name, handler) {
          if (!(name in (module.def.jobs ?? {}))) throw new ModuleCompositionError(`"${module.id}" handles undeclared job "${name}"`);
          if (runtime.jobHandlers[name]) throw new ModuleCompositionError(`"${module.id}" handles job "${name}" twice`);
          runtime.jobHandlers[name] = handler as Runtime["jobHandlers"][string];
        },
        enqueue(caller, name, payload, enqueueOptions = {}) {
          return enqueueFor(runtime, caller, name, payload, enqueueOptions);
        },
        pendingCount(userId, name) {
          jobs().ensureTable();
          const row = rawSqlite(options.db)
            .prepare(
              `SELECT count(*) AS n FROM ${JOBS_TABLE} WHERE module = ? AND user_id = ? AND status IN ('queued', 'running')` +
                (name ? " AND name = ?" : ""),
            )
            .get(...(name ? [module.id, userId, name] : [module.id, userId])) as { n: number };
          return row.n;
        },
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
    for (const name of Object.keys(module.def.jobs ?? {})) {
      if (!runtime.jobHandlers[name]) throw new ModuleCompositionError(`"${module.id}" declares job "${name}" but never handles it`);
    }
    if (options.requirePrivacy && module.def.schema && Object.keys(module.def.schema).length > 0 && runtime.privacy.size === 0 && !runtime.privacyNone) {
      throw new ModuleCompositionError(`"${module.id}" has tables but no privacy hooks: call ctx.privacy.handle(...) or ctx.privacy.none(reason)`);
    }
  }

  /** Runtimes with every module after the providers of what it requires (contracts included, unlike `modules`' order). */
  function byDependency(): Runtime[] {
    const out: Runtime[] = [];
    const done = new Set<Runtime>();
    const visit = (runtime: Runtime) => {
      if (done.has(runtime)) return;
      done.add(runtime);
      for (const requirement of runtime.module.requires) {
        const contract = "__contract" in requirement ? requirement : requirement.contract;
        const provider = contract ? providerOf.get(contract.id) : undefined;
        if (provider) visit(provider);
      }
      out.push(runtime);
    };
    for (const runtime of runtimes.values()) visit(runtime);
    return out;
  }

  async function runPrivacy(kind: "export" | "erase", caller: Caller, subject: string, subjectId: number, request: Partial<PrivacyRequest> = {}) {
    const vault = options.vaultFor(caller.sessionId);
    const full: PrivacyRequest = { terms: (request.terms ?? []).filter((t) => t.trim().length > 0), ...(request.id ? { id: request.id } : {}) };
    const ordered = byDependency();
    // Erase dependents first, so nothing points at what its requirement already removed.
    if (kind === "erase") ordered.reverse();
    const results: PrivacyResult<unknown>[] = [];
    for (const runtime of ordered) {
      const hook = runtime.privacy.get(subject)?.[kind];
      if (!hook) continue;
      const call: PrivacyCall =
        vault && vault.userId === caller.userId
          ? { userId: caller.userId, sessionId: caller.sessionId, vault: vault.scope(runtime.module.id) }
          : { userId: caller.userId, sessionId: caller.sessionId };
      const result = await hook(call, subjectId, full);
      if (result !== undefined) results.push({ module: runtime.module.id, result });
    }
    return results;
  }

  const LOCKED_RETRY_MS = 30_000;

  const runJob = async (row: JobRow, now: number) => {
    const runtime = runtimes.get(row.module)!;
    const event = { id: row.id, module: row.module, name: row.name, sessionId: row.session_id };
    const caller = { userId: row.user_id, sessionId: row.session_id };
    let call: CallContext;
    try {
      await options.prepareVault?.(row.session_id);
      call = callFor(runtime, caller);
    } catch (error) {
      if (!(error instanceof ModuleVaultLockedError)) throw error;
      // Nothing ran, so this isn't an attempt - wait for the next unlock.
      jobs().defer(row.id, now + LOCKED_RETRY_MS);
      options.onJob?.({ ...event, type: "waiting-for-vault" });
      return;
    }
    try {
      await assertAllowed(caller, `${row.module}:${row.name}`); // re-checked at run time: access may have been revoked since
      const handler = runtime.jobHandlers[row.name];
      if (!handler) throw new ModuleCompositionError(`no handler for job "${row.name}"`);
      const schema = (runtime.module.def.jobs ?? {})[row.name]!;
      const payload = await validate(schema, JSON.parse(call.vault.decryptString(`job:${row.name}`, row.payload)), `${row.module} job ${row.name}`);
      await handler(call, payload);
      jobs().done(row.id);
      options.onJob?.({ ...event, type: "done" });
      publishLive(row.user_id, { type: "jobs", module: row.module });
    } catch (error) {
      if (error instanceof JobDeferredError) {
        jobs().defer(row.id, now + Math.max(1000, error.retryInMs));
        options.onJob?.({ ...event, type: "deferred" });
        publishLive(row.user_id, { type: "jobs", module: row.module });
        return;
      }
      const code = error instanceof Error ? error.constructor.name : "UnknownError";
      const outcome = jobs().fail(row, code, now + retryDelayMs(row.attempts));
      options.onJob?.({ ...event, type: outcome, error: code });
      publishLive(row.user_id, { type: "jobs", module: row.module });
      if (outcome === "failed") logError(error, `job ${row.module}.${row.name} #${row.id} failed for good`);
    }
  };

  const scheduled = modules.flatMap((m) =>
    Object.entries(m.def.schedules ?? {}).map(([name, schedule]) => {
      if (!(schedule.job in (m.def.jobs ?? {}))) {
        throw new ModuleCompositionError(`"${m.id}" schedule "${name}" points at unknown job "${schedule.job}"`);
      }
      return { runtime: runtimes.get(m.id)!, name, ...schedule };
    }),
  );

  /** Enqueues every due schedule once per active user (their latest session). */
  const runSchedules = async (now: number) => {
    if (scheduled.length === 0 || !options.activeCallers) return;
    const sqlite = rawSqlite(options.db);
    const byUser = new Map<number, Caller>();
    for (const caller of options.activeCallers()) byUser.set(caller.userId, caller);
    for (const caller of byUser.values()) {
      for (const s of scheduled) {
        const row = sqlite
          .prepare(`SELECT last_run_at FROM ${SCHEDULES_TABLE} WHERE module = ? AND name = ? AND user_id = ?`)
          .get(s.runtime.module.id, s.name, caller.userId) as { last_run_at: number } | undefined;
        if (row && row.last_run_at + s.everyMs > now) continue;
        try {
          await enqueueFor(s.runtime, caller, s.job, s.payload ?? {}, {}, now);
        } catch (error) {
          if (error instanceof ModuleVaultLockedError) continue; // gone since listed - next tick
          throw error;
        }
        sqlite
          .prepare(
            `INSERT INTO ${SCHEDULES_TABLE} (module, name, user_id, last_run_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (module, name, user_id) DO UPDATE SET last_run_at = excluded.last_run_at`,
          )
          .run(s.runtime.module.id, s.name, caller.userId, now);
      }
    }
  };

  const jobRunner: JobRunner = {
    async runDue({ now, limit = Number.POSITIVE_INFINITY } = {}) {
      await runSchedules(now ?? Date.now());
      if (jobModules.length === 0) return 0;
      let ran = 0;
      while (ran < limit) {
        const at = now ?? Date.now();
        const row = jobs().claimNext(jobModules, at);
        if (!row) break;
        await runJob(row, at);
        ran += 1;
      }
      return ran;
    },
    start({ pollMs = 1000 } = {}) {
      if (jobModules.length === 0) return () => {};
      jobs().ensureTable();
      if (scheduled.length > 0) rawSqlite(options.db).exec(SCHEDULES_DDL);
      jobs().recoverRunning(jobModules);
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      const tick = async () => {
        try {
          await jobRunner.runDue();
        } catch (error) {
          logError(error, "module-host: job runner tick failed");
        }
        if (!stopped) timer = setTimeout(tick, pollMs);
      };
      timer = setTimeout(tick, 0);
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    },
  };

  return {
    modules,
    migrate() {
      migrateResolved(options.db, modules);
    },
    jobs: jobRunner,
    actions: () => allActions,
    resources: () => allResources,
    liveConnectionCount: () => live?.connectionCount() ?? 0,
    async routes(app) {
      if (live) {
        await live.register(app, options.requireCaller ?? options.requireVault);
        const unsubscribe = options.vaultEvents?.((change) => live.vaultChanged(change));
        if (unsubscribe) app.addHook("onClose", async () => unsubscribe());
      }
      // Expected failures keep their status; anything else is logged and
      // answered without its message, which may name tables or paths.
      app.setErrorHandler((error, _request, reply) => {
        if (error instanceof ContractInputError) return reply.code(400).send({ error: error.message });
        if (error instanceof OperationError) return reply.code(error.status).send({ error: error.message });
        if (error instanceof ModuleVaultLockedError) return reply.code(423).send({ error: "vault locked" });
        const status = (error as { statusCode?: number }).statusCode;
        if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (error as Error).message });
        logError(error, "module-host: request failed");
        return reply.code(500).send({ error: "internal error" });
      });
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
                if (!op || op.serverOnly) return reply.code(404).send({ error: "unknown operation" });
                let call: CallContext;
                if (runsLocked(op)) {
                  const caller = options.requireCaller!(request, reply);
                  if (!caller) return reply;
                  call = callForOp(runtime, op, caller);
                } else {
                  const unlocked = options.requireVault(request, reply);
                  if (!unlocked) return reply;
                  call = buildCall(runtime, unlocked, unlocked.vault);
                }
                try {
                  const result = await invoke(runtime, op, call, request.body ?? {});
                  // Serialized here: Fastify sends a bare string as text/plain, which the browser can't parse as JSON.
                  return reply.type("application/json; charset=utf-8").send(JSON.stringify(result));
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
            if (Object.keys(module.def.jobs ?? {}).length > 0) {
              // The caller's own jobs for this module - status only, never payloads.
              scope.get("/_jobs", async (request, reply) => {
                const unlocked = options.requireVault(request, reply);
                if (!unlocked) return reply;
                const rows = rawSqlite(options.db)
                  .prepare(
                    `SELECT id, name, status, attempts, error, created_at, updated_at FROM ${JOBS_TABLE}
                     WHERE module = ? AND user_id = ? ORDER BY id DESC LIMIT 50`,
                  )
                  .all(module.id, unlocked.userId) as {
                  id: number;
                  name: string;
                  status: JobSummary["status"];
                  attempts: number;
                  error: string | null;
                  created_at: number;
                  updated_at: number;
                }[];
                const jobsList: JobSummary[] = rows.map((r) => ({
                  id: r.id,
                  name: r.name,
                  status: r.status,
                  attempts: r.attempts,
                  error: r.error,
                  createdAt: new Date(r.created_at).toISOString(),
                  updatedAt: new Date(r.updated_at).toISOString(),
                }));
                return { jobs: jobsList };
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
    async publicRoutes(app) {
      const { max, windowMs } = options.publicRateLimit ?? { max: 120, windowMs: 60_000 };
      const hits = new Map<string, { count: number; resetAt: number }>();
      app.addHook("onRequest", async (request, reply) => {
        const now = Date.now();
        // Drop expired buckets now and then so the map can't grow without bound.
        if (hits.size > 10_000) for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
        const bucket = hits.get(request.ip);
        if (!bucket || bucket.resetAt <= now) hits.set(request.ip, { count: 1, resetAt: now + windowMs });
        else if (++bucket.count > max) return reply.code(429).header("retry-after", Math.ceil((bucket.resetAt - now) / 1000)).send({ error: "too many requests" });
      });
      app.setErrorHandler((error, _request, reply) => {
        if (error instanceof OperationError) return reply.code(error.status).send({ error: error.message });
        logError(error, "module-host: public route failed");
        return reply.code(500).send({ error: "internal error" });
      });
      for (const runtime of runtimes.values()) {
        if (runtime.publicRoutePlugins.length === 0) continue;
        await app.register(
          async (scope) => {
            for (const plugin of runtime.publicRoutePlugins) await plugin(scope);
          },
          { prefix: `/${runtime.module.id}` },
        );
      }
    },
    async internalRoutes(app) {
      const internal = options.internal;
      if (!internal) throw new Error("module-host: internalRoutes needs the `internal: { secret }` option");
      app.setErrorHandler((error, _request, reply) => {
        if (error instanceof ContractInputError) return reply.code(400).send({ error: error.message });
        if (error instanceof OperationError) return reply.code(error.status).send({ error: error.message });
        if (error instanceof ModuleVaultLockedError) return reply.code(423).send({ error: "vault locked" });
        logError(error, "module-host: internal call failed");
        return reply.code(500).send({ error: "internal error" });
      });
      registerInternalRoutes(app, {
        secret: internal.secret,
        async invoke(contractId, opName, version, caller, input) {
          const provider = providerOf.get(contractId);
          const op = provider?.module.contract ? operationsOf(provider.module.contract)[opName] : undefined;
          if (!provider || !op) throw new OperationError(404, `no operation ${contractId}.${opName} here`);
          if (version !== provider.module.contract!.version) {
            throw new OperationError(409, `caller built against "${contractId}" v${version}, this host implements v${provider.module.contract!.version}`);
          }
          if (!runsLocked(op)) await options.prepareVault?.(caller.sessionId);
          return invoke(provider, op, callForOp(provider, op, caller), input);
        },
        publish: (userId, message) => live?.publish(userId, message),
      });
    },
  };
}

export { isContract };
