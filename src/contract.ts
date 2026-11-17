import type { Schema } from "./standardSchema.js";

/**
 * A request/response operation. Schemas must be JSON-safe end to end
 * (strings for dates, no Maps or Buffers): the same contract is served
 * over HTTP to the browser and called in-process on the server, and both
 * paths must produce the same values.
 */
export interface OperationDef {
  readonly input: Schema;
  readonly output: Schema;
}

/** A routable page. `params` parses the path's `:name` segments (strings) into typed values. */
export interface PageDef {
  readonly path: `/${string}`;
  readonly params: Schema;
}

/**
 * An extension point on someone's UI: other modules contribute components
 * that render there with `Props`. Type-only - props are passed in-process,
 * never serialized - so there's no runtime schema.
 */
export interface SlotDef<Props = unknown> {
  readonly kind: "slot";
  /** Phantom field carrying `Props`; never set. */
  readonly __props?: Props;
}

export function slot<Props extends object = Record<string, never>>(): SlotDef<Props> {
  return { kind: "slot" };
}

/**
 * Something other modules can point at by id - a person, a tag, an entry.
 * `page` is a page of this contract with an `id` param; `labels` is a query
 * of this contract taking `{ ids: number[] }` and returning
 * `{ id: number; label: string | null }[]`. That's enough for any module to
 * show and link any entity (`<EntityLink>`) without knowing its owner.
 */
export interface EntityDef {
  readonly page: string;
  readonly labels: string;
}

export interface ContractDef {
  /** Lowercase, `[a-z][a-z0-9-]*`. Also the module's vault scope and route prefix. */
  readonly id: string;
  /** Bump on any breaking change; hosts refuse to boot on a mismatch. */
  readonly version: number;
  readonly queries?: Readonly<Record<string, OperationDef>>;
  readonly commands?: Readonly<Record<string, OperationDef>>;
  readonly events?: Readonly<Record<string, Schema>>;
  readonly pages?: Readonly<Record<string, PageDef>>;
  readonly slots?: Readonly<Record<string, SlotDef<any>>>;
  readonly entities?: Readonly<Record<string, EntityDef>>;
}

/** `T` itself when it fits `Bound` - unlike `T & Bound`, which would merge in Bound's `any`s and erase inference. */
type Narrow<T, Bound> = T extends Bound ? T : never;

type Section<C, K extends string> = C extends { readonly [P in K]: infer S } ? (S extends object ? S : {}) : {};

export interface OperationRef<Id extends string = string, Name extends string = string, Def extends OperationDef = OperationDef>
  extends OperationDef {
  readonly contractId: Id;
  readonly kind: "query" | "command";
  readonly name: Name;
  readonly input: Def["input"];
  readonly output: Def["output"];
}

export interface EventRef<Id extends string = string, Name extends string = string, S extends Schema = Schema> {
  readonly contractId: Id;
  readonly name: Name;
  readonly payload: S;
}

export interface PageRef<Id extends string = string, Name extends string = string, Def extends PageDef = PageDef> extends PageDef {
  readonly contractId: Id;
  readonly name: Name;
  readonly params: Def["params"];
}

export interface SlotRef<Id extends string = string, Name extends string = string, Props = unknown> extends SlotDef<Props> {
  readonly contractId: Id;
  readonly name: Name;
}

export interface EntityRef<Id extends string = string, Name extends string = string> {
  readonly contractId: Id;
  readonly name: Name;
  readonly page: PageRef<Id>;
  readonly labels: OperationRef<Id>;
}

export type Contract<C extends ContractDef = ContractDef> = {
  readonly __contract: true;
  readonly id: C["id"];
  readonly version: C["version"];
  readonly queries: {
    readonly [K in keyof Section<C, "queries"> & string]: OperationRef<C["id"], K, Narrow<Section<C, "queries">[K], OperationDef>>;
  };
  readonly commands: {
    readonly [K in keyof Section<C, "commands"> & string]: OperationRef<C["id"], K, Narrow<Section<C, "commands">[K], OperationDef>>;
  };
  readonly events: {
    readonly [K in keyof Section<C, "events"> & string]: EventRef<C["id"], K, Narrow<Section<C, "events">[K], Schema>>;
  };
  readonly pages: {
    readonly [K in keyof Section<C, "pages"> & string]: PageRef<C["id"], K, Narrow<Section<C, "pages">[K], PageDef>>;
  };
  readonly slots: {
    readonly [K in keyof Section<C, "slots"> & string]: SlotRef<
      C["id"],
      K,
      Section<C, "slots">[K] extends SlotDef<infer P> ? P : never
    >;
  };
  readonly entities: { readonly [K in keyof Section<C, "entities"> & string]: EntityRef<C["id"], K> };
};

export type AnyContract = Contract<ContractDef>;

type EntityConstraint<C extends ContractDef> = {
  readonly entities?: {
    readonly [K in keyof Section<C, "entities">]: {
      readonly page: keyof Section<C, "pages"> & string;
      readonly labels: keyof Section<C, "queries"> & string;
    };
  };
};

const ID = /^[a-z][a-z0-9-]*$/;

export function assertModuleId(id: string, what = "module id"): void {
  if (!ID.test(id)) throw new Error(`invalid ${what} "${id}" - expected lowercase [a-z][a-z0-9-]*`);
}

/**
 * Declares a module's public surface. This object (and the zod schemas in
 * it) is the only thing another module may import from it.
 */
export function defineContract<const C extends ContractDef>(def: C & EntityConstraint<C>): Contract<C> {
  assertModuleId(def.id, "contract id");
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new Error(`contract "${def.id}": version must be a positive integer`);
  }

  const refs = <T extends object, R>(section: Readonly<Record<string, T>> | undefined, build: (name: string, value: T) => R) =>
    Object.fromEntries(Object.entries(section ?? {}).map(([name, value]) => [name, build(name, value)]));

  const queries = refs(def.queries, (name, op) => ({ ...op, contractId: def.id, kind: "query" as const, name }));
  const commands = refs(def.commands, (name, op) => ({ ...op, contractId: def.id, kind: "command" as const, name }));
  for (const name of Object.keys(commands)) {
    if (name in queries) throw new Error(`contract "${def.id}": "${name}" is both a query and a command`);
  }
  const pages = refs(def.pages, (name, page) => {
    if (!page.path.startsWith("/")) throw new Error(`contract "${def.id}": page "${name}" path must start with /`);
    return { ...page, contractId: def.id, name };
  });

  const entities = refs(def.entities, (name, entity) => {
    const page = pages[entity.page];
    const labels = queries[entity.labels];
    if (!page) throw new Error(`contract "${def.id}": entity "${name}" points at unknown page "${entity.page}"`);
    if (!labels) throw new Error(`contract "${def.id}": entity "${name}" points at unknown query "${entity.labels}"`);
    if (!page.path.includes(":id")) {
      throw new Error(`contract "${def.id}": entity "${name}" page "${entity.page}" needs an :id segment`);
    }
    return { contractId: def.id, name, page, labels };
  });

  return {
    __contract: true,
    id: def.id,
    version: def.version,
    queries,
    commands,
    events: refs(def.events, (name, payload) => ({ contractId: def.id, name, payload })),
    pages,
    slots: refs(def.slots, (name, s) => ({ ...s, contractId: def.id, name })),
    entities,
  } as unknown as Contract<C>;
}

/**
 * Thrown by an operation handler for an expected failure ("not found",
 * "already exists"). Over HTTP it becomes that status with `{ error }`;
 * in-process callers catch it like any error.
 */
export class OperationError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isContract(value: unknown): value is AnyContract {
  return typeof value === "object" && value !== null && (value as { __contract?: unknown }).__contract === true;
}

/** Every query and command of a contract, by name. */
export function operationsOf(contract: AnyContract): Record<string, OperationRef> {
  return { ...contract.queries, ...contract.commands } as Record<string, OperationRef>;
}
