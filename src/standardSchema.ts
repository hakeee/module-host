/**
 * The Standard Schema v1 interface (https://standardschema.dev), copied
 * rather than imported, as the spec intends. zod 4 implements it, so
 * contracts are written with zod, but this package never imports zod
 * itself: two copies of zod (one per linked repo) would otherwise make
 * their schema types nominally incompatible.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

// eslint-style `any` is deliberate: this is the "any schema" bound.
// biome-ignore lint: see above
export type Schema = StandardSchemaV1<any, any>;

/** What a schema produces (after transforms) - what handlers receive. */
export type Output<S extends Schema> = NonNullable<S["~standard"]["types"]>["output"];
/** What a schema accepts - what callers pass. */
export type Input<S extends Schema> = NonNullable<S["~standard"]["types"]>["input"];

export class ContractValidationError extends Error {
  readonly issues: ReadonlyArray<StandardIssue>;

  constructor(where: string, issues: ReadonlyArray<StandardIssue>) {
    super(ContractValidationError.describe(where, issues));
    this.issues = issues;
  }

  static describe(where: string, issues: ReadonlyArray<StandardIssue>): string {
    const first = issues[0];
    const path = first?.path?.map((p) => (typeof p === "object" ? String(p.key) : String(p))).join(".");
    return `${where}: ${path ? `${path}: ` : ""}${first?.message ?? "invalid"}`;
  }
}

/** Bad input from a caller (HTTP 400), as opposed to a handler returning the wrong shape (a bug). */
export class ContractInputError extends ContractValidationError {
  constructor(message: string, issues: ReadonlyArray<StandardIssue>) {
    super("", issues);
    this.message = message;
  }
}

export async function validate<S extends Schema>(schema: S, value: unknown, where: string): Promise<Output<S>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw new ContractValidationError(where, result.issues);
  return result.value as Output<S>;
}

/** For places that can't await (URL params during render). Async schemas are rejected. */
export function validateSync<S extends Schema>(schema: S, value: unknown, where: string): Output<S> {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) throw new Error(`${where}: async schemas aren't supported here`);
  if (result.issues) throw new ContractValidationError(where, result.issues);
  return result.value as Output<S>;
}
