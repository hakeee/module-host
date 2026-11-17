import type { AnyContract, OperationDef } from "./contract.js";
import type { Input, Output } from "./standardSchema.js";

/**
 * Contract-level call types, shared by both sides. They live in the root
 * entry (not `/server`) so a contract file can export typed helpers over
 * a client - like the ai module's `generateStructured` - without pulling
 * server code into a browser bundle's type-check.
 */

/** Who a call is on behalf of. Enough to re-derive any module's own vault scope. */
export interface Caller {
  readonly userId: number;
  readonly sessionId: string;
}

type ClientOps<Ops> = {
  readonly [K in keyof Ops]: Ops[K] extends OperationDef
    ? (caller: Caller, input: Input<Ops[K]["input"]>) => Promise<Output<Ops[K]["output"]>>
    : never;
};

/** A typed, validated client for one contract (in-process, or remote over the internal channel). */
export interface Client<C extends AnyContract> {
  readonly queries: ClientOps<C["queries"]>;
  readonly commands: ClientOps<C["commands"]>;
}
