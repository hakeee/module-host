import {
  QueryClientContext,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  Component,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  assertModuleId,
  actionOf,
  isContract,
  operationsOf,
  runsLocked,
  type AnyContract,
  type ComponentRef,
  type EntityRef,
  type EventRef,
  type OperationDef,
  type OperationRef,
  type PageRef,
  type SlotRef,
} from "../contract.js";
import { ModuleCompositionError, resolveModules, visibleContracts } from "../resolve.js";
import { validate, validateSync, type Input, type Output } from "../standardSchema.js";
import { createLiveClient, type LiveClient, type LiveStatus } from "./live.js";
import { browserHistory, buildHref, compileRoute, matchRoute, sortRoutes, type CompiledRoute, type RouterHistory } from "./router.js";

export type { LiveStatus } from "./live.js";

export { browserHistory, memoryHistory, type RouterHistory } from "./router.js";

// --- module definitions -----------------------------------------------------------

// biome-ignore lint: the "any web module" bound
export type AnyWebModule = WebModule<any, any>;
type Requirement = AnyWebModule | AnyContract;
type ContractOf<R> = R extends AnyContract ? R : R extends { readonly contract: infer C } ? (C extends AnyContract ? C : never) : never;
type OwnContract<C> = C extends AnyContract ? C : never;
type VisibleId<C, R extends readonly unknown[]> = (ContractOf<R[number]> | OwnContract<C>)["id"];

export type PageProps<P extends PageRef> = { params: Output<P["params"]> };

type PagesOf<C> = C extends AnyContract
  ? keyof C["pages"] extends never
    ? { readonly pages?: Record<string, never> }
    : { readonly pages: { readonly [K in keyof C["pages"]]: C["pages"][K] extends PageRef ? ComponentType<PageProps<C["pages"][K]>> : never } }
  : { readonly pages?: Record<string, never> };

/** Link/nav params are the parsed values (`id: number`), stringified into the path. */
type ParamsArg<P extends PageRef> = {} extends Output<P["params"]>
  ? { readonly params?: Output<P["params"]> }
  : { readonly params: Output<P["params"]> };

export type NavItem<P extends PageRef = PageRef> = {
  readonly label: string;
  readonly to: P;
  readonly icon?: ComponentType<{ className?: string }>;
  /** Lower first. Default 100. */
  readonly order?: number;
  /** Called as a hook while the nav renders, e.g. a polled count for a badge. */
  readonly useBadge?: () => number | undefined;
  /** Other pages that should also mark this item active (e.g. a detail page under a list item). */
  readonly activeOn?: readonly PageRef[];
} & ParamsArg<P>;

export interface Contribution<Props = unknown> {
  readonly slot: SlotRef<string, string, Props>;
  readonly component: ComponentType<Props>;
  readonly order: number;
}

/** A component for someone's slot. Props are checked against the slot's declared type. */
export function contribute<Props>(slot: SlotRef<string, string, Props>, component: ComponentType<NoInfer<Props>>, options: { order?: number } = {}): Contribution<Props> {
  return { slot, component, order: options.order ?? 100 };
}

type ComponentsOf<C> = C extends AnyContract
  ? keyof C["components"] extends never
    ? { readonly components?: Record<string, never> }
    : {
        readonly components: {
          readonly [K in keyof C["components"]]: C["components"][K] extends ComponentRef<string, string, infer P> ? ComponentType<P> : never;
        };
      }
  : { readonly components?: Record<string, never> };

export type WebModuleParts<C extends AnyContract | undefined> = PagesOf<C> & ComponentsOf<C> & {
  // biome-ignore lint: nav targets are validated at runtime against visible contracts
  readonly nav?: readonly NavItem<any>[];
  // biome-ignore lint: see above
  readonly contributions?: readonly Contribution<any>[];
};

export interface WebModule<C extends AnyContract | undefined = AnyContract | undefined, R extends readonly Requirement[] = readonly Requirement[]> {
  readonly kind: "web-module";
  readonly id: string;
  readonly contract: C;
  readonly requires: R;
  readonly parts: WebModuleParts<C>;
}

export interface WebModuleBuilder<C extends AnyContract | undefined, R extends readonly Requirement[]> {
  readonly id: string;
  readonly contract: C;
  readonly requires: R;
  /** Typed data hooks for this module's own contract or one it requires. Anything else is a type error. */
  useModule<U extends ContractOf<R[number]> | OwnContract<C>>(contract: U): ContractHooks<U>;
  /**
   * A UI component another module offers through its contract (or this
   * module's own). Renders inside an error boundary; renders `null` if no
   * installed web module implements it (e.g. a backend-only install).
   */
  useComponent<Props>(component: ComponentRef<VisibleId<C, R>, string, Props>): ComponentType<Props>;
  /**
   * The element form of `useComponent`: `<mod.Component of={ref} {...props} />`.
   * Same checks and boundary; reads better in JSX and keeps lint rules
   * about components created during render quiet.
   */
  readonly Component: <Props extends object>(props: { of: ComponentRef<VisibleId<C, R>, string, Props> } & Props) => ReactNode;
  /**
   * The current user's recent jobs of a visible module (status only - never
   * payloads). Refetched live as jobs move along, when `<LiveConnection>`
   * is mounted.
   */
  useJobs(contract: ContractOf<R[number]> | OwnContract<C>): UseQueryResult<{ jobs: JobSummary[] }, ModuleRpcError>;
  /** Runs `handler` for each live event of a visible contract (see `<LiveConnection>`). */
  useLiveEvent<U extends ContractOf<R[number]> | OwnContract<C>, E extends keyof U["events"] & string>(
    contract: U,
    event: E,
    handler: (payload: Output<U["events"][E] extends EventRef<string, string, infer S> ? S : never>) => void,
  ): void;
  /** Pages (one per page in the contract), nav entries and slot contributions. */
  define(parts: WebModuleParts<C>): WebModule<C, R>;
}

/**
 * Declare first, define after: components written between the two can
 * call `mod.useModule(...)`, typed against this module's `requires`.
 *
 * ```tsx
 * const mod = webModule({ contract: peopleContract, requires: [journalContract] });
 * function PersonPage({ params }: PageProps<typeof peopleContract.pages.detail>) {
 *   const people = mod.useModule(peopleContract);
 *   const person = people.queries.get.useQuery({ id: params.id });
 *   ...
 * }
 * export default mod.define({ pages: { detail: PersonPage } });
 * ```
 *
 * A module can be all UI (pages and contributions over someone else's
 * contract), all data (a contract whose hooks other modules use, with no
 * pages), or both.
 */
export function webModule<const C extends AnyContract | undefined = undefined, const R extends readonly Requirement[] = readonly []>(decl: {
  readonly id?: string;
  readonly contract?: C;
  readonly requires?: R;
}): WebModuleBuilder<C, R> {
  const id = decl.id ?? decl.contract?.id;
  if (!id) throw new Error("a web module without a contract needs an id");
  assertModuleId(id);
  const contract = decl.contract as C;
  const requires = (decl.requires ?? []) as R;
  const visible = visibleContracts({ id, contract, requires });

  return {
    id,
    contract,
    requires,
    useModule(target) {
      if (!visible.has(target.id)) throw new ModuleCompositionError(`"${id}" uses contract "${target.id}" without requiring it`);
      return useContractHooks(target);
    },
    useComponent(ref) {
      if (!visible.has(ref.contractId)) throw new ModuleCompositionError(`"${id}" uses a component of "${ref.contractId}" without requiring it`);
      const { host } = useHostContext();
      return host.exposedComponent(ref as ComponentRef) as never;
    },
    Component: function ModuleComponent(props) {
      const { of: ref, ...rest } = props as { of: ComponentRef } & Record<string, unknown>;
      if (!visible.has(ref.contractId)) throw new ModuleCompositionError(`"${id}" uses a component of "${ref.contractId}" without requiring it`);
      const { host } = useHostContext();
      const Exposed = host.exposedComponent(ref);
      return <Exposed {...rest} />;
    } as WebModuleBuilder<C, R>["Component"],
    useJobs(target: AnyContract) {
      if (!visible.has(target.id)) throw new ModuleCompositionError(`"${id}" reads jobs of "${target.id}" without requiring it`);
      const { host, unlocked } = useHostContext();
      return useQuery({
        queryKey: [target.id, "_jobs"],
        queryFn: () => host.get(`/${target.id}/_jobs`) as Promise<{ jobs: JobSummary[] }>,
        enabled: unlocked,
      });
    },
    useLiveEvent(target, event, handler) {
      if (!visible.has(target.id)) throw new ModuleCompositionError(`"${id}" listens to "${target.id}" without requiring it`);
      useLiveSubscription(target.id, event, handler as (payload: unknown) => void);
    },
    define(parts) {
      return { kind: "web-module", id, contract, requires, parts };
    },
  };
}

// --- data hooks ----------------------------------------------------------------

type QueryHooks<O extends OperationDef> = {
  useQuery(
    input: Input<O["input"]>,
    options?: Omit<UseQueryOptions<Output<O["output"]>, ModuleRpcError>, "queryKey" | "queryFn">,
  ): UseQueryResult<Output<O["output"]>, ModuleRpcError>;
  fetch(input: Input<O["input"]>): Promise<Output<O["output"]>>;
  /** `[contractId, operation, input?]` - omit input to address every cached input. */
  key(input?: Input<O["input"]>): QueryKey;
  invalidate(input?: Input<O["input"]>): Promise<void>;
};

type CommandHooks<O extends OperationDef> = {
  useMutation(
    options?: Omit<UseMutationOptions<Output<O["output"]>, ModuleRpcError, Input<O["input"]>>, "mutationFn">,
  ): UseMutationResult<Output<O["output"]>, ModuleRpcError, Input<O["input"]>>;
  call(input: Input<O["input"]>): Promise<Output<O["output"]>>;
};

export interface ContractHooks<C extends AnyContract> {
  readonly queries: { readonly [K in keyof C["queries"]]: C["queries"][K] extends OperationDef ? QueryHooks<C["queries"][K]> : never };
  readonly commands: { readonly [K in keyof C["commands"]]: C["commands"][K] extends OperationDef ? CommandHooks<C["commands"][K]> : never };
  /** Invalidates every cached query of this contract, e.g. after a command that changes a lot. */
  invalidateAll(): Promise<void>;
}

/** A job as `useJobs` reports it. */
export interface JobSummary {
  id: number;
  name: string;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ModuleRpcError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function buildContractHooks(contract: AnyContract, host: WebHost, queryClient: QueryClient): ContractHooks<AnyContract> {
  const call = (op: OperationRef) => async (input: unknown) => {
    const where = `${op.contractId}.${op.name}`;
    const raw = await host.rpc(op.contractId, op.name, await validate(op.input, input ?? {}, `${where} input`));
    return validate(op.output, raw, `${where} output`);
  };
  const key = (op: OperationRef) => (input?: unknown) => (input === undefined ? [op.contractId, op.name] : [op.contractId, op.name, input]);

  const queries = Object.fromEntries(
    Object.entries(contract.queries as Record<string, OperationRef>).map(([name, op]) => {
      const fetch = call(op);
      const keyOf = key(op);
      return [
        name,
        {
          // biome-ignore lint: forwarded straight to react-query
          useQuery: (input: unknown, options?: any) => {
            // Paused while locked (instead of failing with 423) or not allowed (403); resumes when that changes.
            const unlocked = useVaultUnlocked();
            const allowed = useCan(actionOf(op));
            const enabled = (runsLocked(op) || unlocked) && allowed ? (options?.enabled ?? true) : false;
            return useQuery({ ...options, enabled, queryKey: keyOf(input ?? {}), queryFn: () => fetch(input) });
          },
          fetch,
          key: keyOf,
          invalidate: (input?: unknown) => queryClient.invalidateQueries({ queryKey: keyOf(input) }),
        },
      ];
    }),
  );
  const commands = Object.fromEntries(
    Object.entries(contract.commands as Record<string, OperationRef>).map(([name, op]) => {
      const run = call(op);
      // biome-ignore lint: forwarded straight to react-query
      return [name, { useMutation: (options?: any) => useMutation({ ...options, mutationFn: run }), call: run }];
    }),
  );
  return {
    queries,
    commands,
    invalidateAll: () => queryClient.invalidateQueries({ queryKey: [contract.id] }),
  } as unknown as ContractHooks<AnyContract>;
}

function useContractHooks<C extends AnyContract>(contract: C): ContractHooks<C> {
  const { host } = useHostContext();
  const queryClient = useQueryClient();
  return useMemo(() => buildContractHooks(contract, host, queryClient), [contract, host, queryClient]) as unknown as ContractHooks<C>;
}

// --- host ---------------------------------------------------------------------------

export interface WebHostOptions {
  /** The app's top-level web modules; their requirements are pulled in. */
  modules: readonly AnyWebModule[];
  /** Where the server host is mounted, e.g. `https://api.example.com/m`. */
  baseUrl: string;
  history?: RouterHistory;
  /** Where `/` goes when no page claims it. */
  home?: PageRef;
  fetch?: typeof fetch;
  /** WebSocket URL for live updates. Default: `baseUrl` with ws(s):// and `/_live`. */
  liveUrl?: string;
  /** For tests. */
  WebSocket?: typeof WebSocket;
  /**
   * Called when a request comes back 423 (vault locked) - e.g. to re-check
   * vault state so the app shows its locked UI. The live socket usually
   * reports a lock first; this catches the rest.
   */
  onVaultLocked?: () => void;
}

interface ResolvedNavItem {
  readonly module: string;
  readonly label: string;
  readonly href: string;
  readonly page: PageRef;
  readonly icon?: ComponentType<{ className?: string }>;
  readonly useBadge?: () => number | undefined;
  readonly activeOn: readonly PageRef[];
  readonly order: number;
}

export interface WebHost {
  readonly modules: readonly AnyWebModule[];
  readonly history: RouterHistory;
  readonly routes: readonly CompiledRoute[];
  readonly nav: readonly ResolvedNavItem[];
  readonly home: PageRef | undefined;
  componentFor(page: PageRef): ComponentType<{ params: unknown }> | undefined;
  /** A stable wrapper for a contract component: boundary + implementation, or `null` when none is installed. */
  exposedComponent(ref: ComponentRef): ComponentType<unknown>;
  readonly live: LiveClient;
  contributionsFor(slot: SlotRef): readonly Contribution[];
  href<P extends PageRef>(page: P, params?: Output<P["params"]>): string;
  rpc(contractId: string, op: string, input: unknown): Promise<unknown>;
  /** GET a path under `baseUrl` (credentials included). */
  get(path: string): Promise<unknown>;
  /** One label for an entity id; lookups in the same tick are batched into one request per entity type. */
  label(entity: EntityRef, id: number): Promise<string | null>;
  /** Every contract this bundle knows (installed web modules' and their requirements'), by id. */
  readonly contracts: ReadonlyMap<string, AnyContract>;
}

export function createWebHost(options: WebHostOptions): WebHost {
  const modules = resolveModules(options.modules, "web", { requireProviders: false });
  const history = options.history ?? browserHistory();
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const pageComponents = new Map<string, ComponentType<{ params: unknown }>>();
  const compiled: CompiledRoute[] = [];
  const contributions = new Map<string, Contribution[]>();
  const nav: ResolvedNavItem[] = [];
  const pageKey = (page: { contractId: string; name: string }) => `${page.contractId}.${page.name}`;
  const knownPages = new Map<string, PageRef>();

  for (const module of modules) {
    const contract = module.contract as AnyContract | undefined;
    const pages = (module.parts.pages ?? {}) as Record<string, ComponentType<{ params: unknown }>>;
    for (const [name, page] of Object.entries((contract?.pages ?? {}) as Record<string, PageRef>)) {
      const component = pages[name];
      if (!component) throw new ModuleCompositionError(`web "${module.id}" has no component for page "${name}"`);
      pageComponents.set(pageKey(page), component);
      knownPages.set(pageKey(page), page);
      const route = compileRoute(page);
      const clash = compiled.find((r) => r.pattern.source === route.pattern.source);
      if (clash) {
        throw new ModuleCompositionError(`pages "${pageKey(clash.page)}" and "${pageKey(page)}" share the path ${page.path}`);
      }
      compiled.push(route);
    }
    for (const name of Object.keys(pages)) {
      if (!contract || !(name in contract.pages)) throw new ModuleCompositionError(`web "${module.id}" has a component for unknown page "${name}"`);
    }
  }

  const componentImpls = new Map<string, ComponentType<unknown>>();
  for (const module of modules) {
    const contract = module.contract as AnyContract | undefined;
    const given = (module.parts.components ?? {}) as Record<string, ComponentType<unknown>>;
    for (const name of Object.keys((contract?.components ?? {}) as Record<string, ComponentRef>)) {
      const impl = given[name];
      if (!impl) throw new ModuleCompositionError(`web "${module.id}" has no implementation for component "${name}"`);
      componentImpls.set(`${contract!.id}.${name}`, impl);
    }
    for (const name of Object.keys(given)) {
      if (!contract || !(name in contract.components)) {
        throw new ModuleCompositionError(`web "${module.id}" implements unknown component "${name}"`);
      }
    }
  }
  const wrappers = new Map<string, ComponentType<unknown>>();
  const exposedComponent = (ref: ComponentRef): ComponentType<unknown> => {
    const key = pageKey(ref);
    let wrapper = wrappers.get(key);
    if (!wrapper) {
      const Impl = componentImpls.get(key);
      const Wrapped = (props: unknown) =>
        Impl ? (
          <ContributionBoundary label={`component ${key}`}>
            <Impl {...(props as object)} />
          </ContributionBoundary>
        ) : null;
      Wrapped.displayName = `Module(${key})`;
      wrapper = Wrapped;
      wrappers.set(key, wrapper);
    }
    return wrapper;
  };

  const knownContracts = new Map<string, AnyContract>();
  for (const module of modules) {
    if (module.contract) knownContracts.set(module.contract.id, module.contract as AnyContract);
    for (const requirement of module.requires as readonly Requirement[]) {
      const contract = isContract(requirement) ? requirement : (requirement.contract as AnyContract | undefined);
      if (contract) knownContracts.set(contract.id, contract);
    }
  }
  const live = createLiveClient({
    url: options.liveUrl ?? options.baseUrl.replace(/^http/, "ws") + "/_live",
    contracts: knownContracts,
    WebSocketImpl: options.WebSocket,
  });

  for (const module of modules) {
    const visible = visibleContracts(module);
    const assertVisible = (contractId: string, what: string) => {
      if (!visible.has(contractId)) throw new ModuleCompositionError(`web "${module.id}" ${what} of "${contractId}" without requiring it`);
    };
    for (const c of module.parts.contributions ?? []) {
      assertVisible(c.slot.contractId, `contributes to a slot`);
      const key = pageKey(c.slot);
      contributions.set(key, [...(contributions.get(key) ?? []), c].sort((a, b) => a.order - b.order));
    }
    for (const item of module.parts.nav ?? []) {
      assertVisible(item.to.contractId, `links nav to a page`);
      if (!knownPages.has(pageKey(item.to))) {
        throw new ModuleCompositionError(`web "${module.id}" links nav to "${pageKey(item.to)}", which no installed module renders`);
      }
      nav.push({
        module: module.id,
        label: item.label,
        page: item.to,
        href: buildHref(item.to, item.params as Record<string, unknown> | undefined),
        icon: item.icon,
        useBadge: item.useBadge,
        activeOn: item.activeOn ?? [],
        order: item.order ?? 100,
      });
    }
  }
  nav.sort((a, b) => a.order - b.order);

  type LabelBatch = {
    entity: EntityRef;
    waiting: Map<number, { resolve: (label: string | null) => void; reject: (error: unknown) => void }[]>;
  };
  const labelBatches = new Map<string, LabelBatch>();
  const flushLabels = async ({ entity, waiting }: LabelBatch) => {
    const ids = [...waiting.keys()];
    try {
      const raw = await hostRpc(entity.contractId, entity.labels.name, { ids });
      const rows = (await validate(entity.labels.output, raw, `${entity.contractId}.${entity.labels.name} output`)) as {
        id: number;
        label: string | null;
      }[];
      const byId = new Map(rows.map((r) => [r.id, r.label]));
      for (const [id, list] of waiting) for (const w of list) w.resolve(byId.get(id) ?? null);
    } catch (error) {
      for (const list of waiting.values()) for (const w of list) w.reject(error);
    }
  };

  if (options.home && !knownPages.has(pageKey(options.home))) {
    throw new ModuleCompositionError(`home page "${pageKey(options.home)}" isn't rendered by any installed module`);
  }

  const parse = async (response: Response) => {
    if (!response.ok) {
      if (response.status === 423) options.onVaultLocked?.();
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ModuleRpcError(response.status, body.error ?? response.statusText);
    }
    return response.json();
  };

  const hostRpc = async (contractId: string, op: string, input: unknown) => {
    const response = await doFetch(`${options.baseUrl}/${contractId}/rpc/${op}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return parse(response);
  };

  return {
    modules,
    history,
    routes: sortRoutes(compiled),
    nav,
    home: options.home,
    componentFor: (page) => pageComponents.get(pageKey(page)),
    exposedComponent,
    live,
    contributionsFor: (slot) => contributions.get(pageKey(slot)) ?? [],
    href: (page, params) => buildHref(page, params as Record<string, unknown> | undefined),
    contracts: knownContracts,
    async get(path) {
      return parse(await doFetch(`${options.baseUrl}${path}`, { credentials: "include" }));
    },
    label(entity, id) {
      const key = `${entity.contractId}.${entity.labels.name}`;
      let batch = labelBatches.get(key);
      if (!batch) {
        batch = { entity, waiting: new Map() };
        labelBatches.set(key, batch);
        const current = batch;
        setTimeout(() => {
          labelBatches.delete(key);
          void flushLabels(current);
        }, 0);
      }
      const waiting = batch.waiting;
      return new Promise((resolve, reject) => {
        const list = waiting.get(id) ?? [];
        list.push({ resolve, reject });
        waiting.set(id, list);
      });
    },
    rpc: hostRpc,
  };
}

// --- react bindings ---------------------------------------------------------------

interface HostContextValue {
  host: WebHost;
  location: string;
  unlocked: boolean;
}

const HostContext = createContext<HostContextValue | null>(null);

function useHostContext(): HostContextValue {
  const value = useContext(HostContext);
  if (!value) throw new Error("module-host: wrap the app in <ModuleHostProvider>");
  return value;
}

/**
 * `unlocked` is the app's word on the vault (e.g. from vault-service's
 * `useVaultGate`). Default `true`, for apps that only render modules once
 * unlocked. Pass it to render modules while only logged in: queries that
 * need the vault pause, `<WhenUnlocked>` shows its fallback, and cached
 * results of those queries are cleared on lock, so decrypted data doesn't
 * stay on screen or in memory.
 */
export function ModuleHostProvider({ host, children, unlocked = true }: { host: WebHost; children: ReactNode; unlocked?: boolean }) {
  const location = useSyncExternalStore(host.history.subscribe, host.history.location, host.history.location);
  const value = useMemo(() => ({ host, location, unlocked }), [host, location, unlocked]);
  const queryClient = useContext(QueryClientContext);
  useEffect(() => {
    if (unlocked || !queryClient) return;
    // Reset, not remove: mounted components keep a removed query's last
    // result on screen. They're paused while locked, so nothing refetches.
    void queryClient.resetQueries({ predicate: (query) => needsVault(host, query.queryKey) });
  }, [unlocked, host, queryClient]);
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

/** Whether a cached query (`[contractId, op, input]` or `[contractId, "_jobs"]`) came from something that needs the vault. */
function needsVault(host: WebHost, key: QueryKey): boolean {
  const [contractId, name] = key;
  if (typeof contractId !== "string" || typeof name !== "string") return false;
  const contract = host.contracts.get(contractId);
  if (!contract) return false;
  if (name === "_jobs") return true;
  const op = (contract.queries as Record<string, OperationRef>)[name];
  return op !== undefined && !runsLocked(op);
}

/** The web host from `<ModuleHostProvider>` - for code that needs the installed contracts or routes. */
export function useWebHost(): WebHost {
  return useHostContext().host;
}

/** Whether the vault is unlocked, as the app told `<ModuleHostProvider unlocked>`. */
export function useVaultUnlocked(): boolean {
  return useHostContext().unlocked;
}

/**
 * Renders `children` only while the vault is unlocked, else `fallback`
 * (e.g. "Unlock to see this" with an unlock button). For parts of a page
 * that need the vault, on a page that otherwise works while locked.
 */
export function WhenUnlocked({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return <>{useVaultUnlocked() ? children : fallback}</>;
}

export function useNavigate() {
  const { host } = useHostContext();
  return <P extends PageRef>(page: P, ...[params]: {} extends Output<P["params"]> ? [params?: Output<P["params"]>] : [params: Output<P["params"]>]) =>
    host.history.push(host.href(page, params));
}

/**
 * Client-side navigation to an already-built href (e.g. a nav entry's
 * `href`). Returns a click handler that leaves modified clicks (new tab,
 * etc.) to the browser.
 */
export function useNavigateHref() {
  const { host } = useHostContext();
  return (href: string) => (event?: MouseEvent<HTMLAnchorElement>) => {
    if (event && (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
    event?.preventDefault();
    host.history.push(href);
  };
}

/** The matched page and its parsed params, or undefined. */
export function useRoute(): { page: PageRef; params: unknown } | undefined {
  const { host, location } = useHostContext();
  return useMemo(() => {
    const match = matchRoute(host.routes, location);
    if (!match) return undefined;
    try {
      return { page: match.route.page, params: validateSync(match.route.page.params, match.raw, "route params") };
    } catch {
      return undefined;
    }
  }, [host, location]);
}

export type LinkProps<P extends PageRef> = {
  readonly to: P;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly title?: string;
} & ParamsArg<P>;

export function Link<P extends PageRef>(props: LinkProps<P>) {
  const { host } = useHostContext();
  const href = host.href(props.to, (props as { params?: Output<P["params"]> }).params);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    host.history.push(href);
  };
  return (
    <a href={href} onClick={onClick} className={props.className} title={props.title}>
      {props.children}
    </a>
  );
}

/**
 * Renders the page for the current location. `/` falls back to `home`;
 * anything else unmatched renders `notFound`, and a page whose `action`
 * is denied renders `forbidden` (default: `notFound`).
 */
export function RouterOutlet({ notFound = null, forbidden }: { notFound?: ReactNode; forbidden?: ReactNode }) {
  const { host, location } = useHostContext();
  const access = useContext(AccessContext);
  const route = useRoute();
  if (!route) {
    const pathname = location.split("?")[0];
    if ((pathname === "/" || pathname === "") && host.home) {
      queueMicrotask(() => host.history.replace(host.href(host.home!, {} as never)));
      return null;
    }
    return <>{notFound}</>;
  }
  if (route.page.action !== undefined) {
    if (!access.ready) return null;
    if (!access.can(route.page.action)) return <>{forbidden ?? notFound}</>;
  }
  const PageComponent = host.componentFor(route.page)!;
  return (
    <ContributionBoundary label={`page ${route.page.contractId}.${route.page.name}`} key={location}>
      <PageComponent params={route.params} />
    </ContributionBoundary>
  );
}

export interface NavEntry extends ResolvedNavItem {
  readonly active: boolean;
}

/** Nav entries the user may see: items whose page has an `action` they're denied drop out. */
export function useNav(): readonly NavEntry[] {
  const { host } = useHostContext();
  const access = useContext(AccessContext);
  const route = useRoute();
  const isRoute = (page: PageRef) => route !== undefined && route.page.contractId === page.contractId && route.page.name === page.name;
  return host.nav
    .filter((item) => item.page.action === undefined || (access.ready && access.can(item.page.action)))
    .map((item) => ({ ...item, active: isRoute(item.page) || item.activeOn.some(isRoute) }));
}

// --- access ---------------------------------------------------------------------------

interface AccessValue {
  can(action: string): boolean;
  /** False while permissions are loading: gated UI renders nothing rather than flashing "forbidden". */
  ready: boolean;
}

const AccessContext = createContext<AccessValue>({ can: () => true, ready: true });

/**
 * What the user may do, for hiding UI - the server enforces it regardless
 * (see the host's `authorize`). Without a provider everything is allowed.
 * The built-in IAM module's `<IamAccess>` provides one.
 */
export function AccessProvider({ can, ready = true, children }: { can: (action: string) => boolean; ready?: boolean; children: ReactNode }) {
  const value = useMemo(() => ({ can, ready }), [can, ready]);
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

/** Whether the user may perform `action` (`module:action`). False while permissions load. */
export function useCan(action: string): boolean {
  const access = useContext(AccessContext);
  return access.ready && access.can(action);
}

/** Renders `children` only when `action` is allowed, else `fallback`. */
export function IfCan({ action, children, fallback = null }: { action: string; children: ReactNode; fallback?: ReactNode }) {
  return <>{useCan(action) ? children : fallback}</>;
}

const noBadge = () => undefined;

/** Runs a nav item's badge hook. Call it from the component that renders that one item. */
export function useNavBadge(item: Pick<ResolvedNavItem, "useBadge">): number | undefined {
  return (item.useBadge ?? noBadge)();
}

/** Every contribution to a slot, ordered - for pages that lay them out themselves (tabs, a grid). */
export function useSlot<Props>(slot: SlotRef<string, string, Props>): readonly Contribution<Props>[] {
  const { host } = useHostContext();
  return host.contributionsFor(slot as SlotRef) as readonly Contribution<Props>[];
}

/**
 * Renders every module's contribution to `slot`, in order, each inside its
 * own error boundary so one broken contribution can't take the page down.
 */
export function Slot<Props>({ slot, props, wrap }: { slot: SlotRef<string, string, Props>; props: Props; wrap?: (node: ReactNode, index: number) => ReactNode }) {
  const contributions = useSlot(slot);
  return (
    <>
      {contributions.map((c, i) => {
        const Contributed = c.component as ComponentType<Props & object>;
        const node = (
          <ContributionBoundary key={i} label={`${slot.contractId}.${slot.name} contribution`}>
            <Contributed {...(props as Props & object)} />
          </ContributionBoundary>
        );
        return wrap ? <div key={i}>{wrap(node, i)}</div> : node;
      })}
    </>
  );
}

class ContributionBoundary extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error(`module-host: ${this.props.label} crashed`, error);
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Opens the live-update socket while mounted. Without the host's
 * `requireCaller` the server only admits unlocked sessions, so mount it
 * where the vault is unlocked; with it, mount it once logged in and pass
 * `onVaultChange` to hear about locks and unlocks right away (e.g. to
 * re-check vault state). Incoming events refetch the queries their
 * contract names in `invalidates`, run `useLiveEvent` handlers, and after
 * a reconnect or an unlock every live contract's queries are refetched,
 * since events may have been missed meanwhile.
 */
export function LiveConnection({ onVaultChange }: { onVaultChange?: (unlocked: boolean) => void } = {}) {
  const { host } = useHostContext();
  const queryClient = useQueryClient();
  const latest = useRef(onVaultChange);
  useEffect(() => {
    latest.current = onVaultChange;
  });
  useEffect(
    () =>
      host.live.connect({
        invalidate: (contractId, query) =>
          void queryClient.invalidateQueries({ queryKey: query ? [contractId, query] : [contractId] }),
        onReconnect: (contractIds) => {
          for (const id of contractIds) void queryClient.invalidateQueries({ queryKey: [id] });
        },
        onVault: (unlocked) => latest.current?.(unlocked),
      }),
    [host, queryClient],
  );
  return null;
}

/** "idle" (no `<LiveConnection>` mounted), "connecting", "open" or "closed" (retrying). */
export function useLiveStatus(): LiveStatus {
  const { host } = useHostContext();
  return useSyncExternalStore(host.live.subscribeStatus, host.live.status, host.live.status);
}

function useLiveSubscription(contractId: string, event: string, handler: (payload: unknown) => void) {
  const { host } = useHostContext();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => host.live.subscribe(contractId, event, (payload) => latest.current(payload)), [host, contractId, event]);
}

export interface ContractVersionMismatch {
  readonly id: string;
  /** What this bundle was built against. */
  readonly web: number;
  /** What the server runs; `null` when it doesn't run that contract at all. */
  readonly server: number | null;
}

/**
 * Compares the contracts this bundle was built against with what the
 * server runs (`GET /_manifest`). A mismatch usually means a stale tab
 * after a deploy - prompt a reload. Contracts the server lists as
 * implemented elsewhere (remotes) don't appear in its manifest, so only
 * contracts it runs itself are compared.
 */
export function useContractVersionCheck(): { mismatches: readonly ContractVersionMismatch[]; checked: boolean } {
  const { host } = useHostContext();
  const manifest = useQuery({
    queryKey: ["__module_host", "manifest"],
    queryFn: () => host.get("/_manifest") as Promise<{ modules: { id: string; contract: { id: string; version: number } | null }[] }>,
    staleTime: 60_000,
  });
  return useMemo(() => {
    if (!manifest.data) return { mismatches: [], checked: false };
    const server = new Map(manifest.data.modules.flatMap((m) => (m.contract ? [[m.contract.id, m.contract.version] as const] : [])));
    const mismatches: ContractVersionMismatch[] = [];
    for (const contract of host.contracts.values()) {
      const version = server.get(contract.id);
      if (version !== undefined && version !== contract.version) mismatches.push({ id: contract.id, web: contract.version, server: version });
    }
    return { mismatches, checked: true };
  }, [manifest.data, host]);
}

/**
 * Shows and links any entity by id - a person from journal's UI, say -
 * via the owning contract's `labels` query and `:id` page, without
 * importing anything from the owner beyond its contract.
 */
export function EntityLink({ entity, id, className, fallback = "Unknown" }: { entity: EntityRef; id: number; className?: string; fallback?: string }) {
  const { host } = useHostContext();
  const label = useQuery({
    queryKey: [entity.contractId, entity.labels.name, { ids: [id] }],
    queryFn: () => host.label(entity, id),
  });
  return (
    <Link to={entity.page as PageRef} params={{ id } as never} className={className}>
      {label.data ?? fallback}
    </Link>
  );
}

export { isContract, operationsOf };
