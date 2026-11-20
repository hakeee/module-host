import type { ActionKind, ResourceAttributeValue, ResourceCheck } from "../contract.js";

/**
 * AWS IAM, cut down to what modules need. A policy is a list of statements;
 * each allows or denies actions (`module:action`, `*` wildcards anywhere,
 * case-insensitive). An explicit deny beats any allow; anything not allowed
 * is denied. `kind` narrows a statement to queries (reads) or commands
 * (writes), which is how ReadOnlyAccess works without listing every query;
 * `notActions` carves out exceptions.
 *
 * **Records.** `resources` limits a statement to records
 * (`clients:client/42`, `clients:client/*`) and `conditions` to records whose
 * attributes match (`{ "clients:trainers": "${user.id}" }`: any value equal
 * to any listed value). `${user.id}` is the caller. Such a *scoped*
 * statement:
 * - in a check for one record, applies when the record matches;
 * - in a check of the operation itself (no record), applies only if it's
 *   an allow and the operation declares a `resource`: it lets the call run
 *   and the handler checks each record. Elsewhere it's ignored, so it can
 *   never open up an operation that doesn't check records, and a scoped
 *   deny never blocks a whole operation.
 */
export interface PolicyStatement {
  readonly effect: "allow" | "deny";
  readonly actions: string[];
  /** Exceptions to `actions` (AWS's NotAction): `actions: ["*"], notActions: ["iam:*"]` is everything but IAM. */
  readonly notActions?: string[];
  readonly kind?: "query" | "command";
  /** Record patterns (`<module>:<type>/<id>`, wildcards, `${user.id}`). Absent or containing `"*"`: every record. */
  readonly resources?: string[];
  /** Attribute (`<module>:<attribute>`) → value(s) it must have, all of them. */
  readonly conditions?: Readonly<Record<string, string | string[]>>;
}

export interface PolicyDocument {
  readonly version: 1;
  readonly statements: PolicyStatement[];
}

/** What a policy check needs to know about an action. A bare kind is accepted too. */
export interface ActionMeta {
  readonly kind?: ActionKind;
  /** Set when the action's operation checks records of this type. */
  readonly resource?: string;
}
export type ActionInfoOf = (action: string) => ActionKind | ActionMeta | undefined;

export interface PolicyRequest {
  /** The record being checked; absent for the operation itself. */
  readonly resource?: ResourceCheck;
  /** The caller, for `${user.id}`. */
  readonly userId?: number;
}

/** The variables a policy may use. Anything else in `${...}` is rejected when a policy is saved. */
export const POLICY_VARIABLES = ["user.id"] as const;

const patternCache = new Map<string, RegExp>();

export function actionMatches(pattern: string, action: string): boolean {
  let regex = patternCache.get(pattern);
  if (!regex) {
    const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    regex = new RegExp(`^${escaped.join(".*")}$`, "i");
    patternCache.set(pattern, regex);
  }
  return regex.test(action);
}

const VARIABLE = /\$\{([^}]*)\}/g;
/** Fills in `${user.id}`; undefined when a variable can't be resolved (the statement then doesn't apply). */
function substitute(text: string, request: PolicyRequest): string | undefined {
  let unresolved = false;
  const out = text.replace(VARIABLE, (_, name: string) => {
    if (name === "user.id" && request.userId !== undefined) return String(request.userId);
    unresolved = true;
    return "";
  });
  return unresolved ? undefined : out;
}

const toList = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
const attributeValues = (value: ResourceAttributeValue | undefined): string[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value.map(String) : [String(value)];

export function isScoped(statement: PolicyStatement): boolean {
  const records = statement.resources !== undefined && !statement.resources.includes("*");
  return records || Object.keys(statement.conditions ?? {}).length > 0;
}

function recordMatches(statement: PolicyStatement, resource: ResourceCheck, request: PolicyRequest): boolean {
  if (statement.resources && !statement.resources.includes("*")) {
    const hit = statement.resources.some((pattern) => {
      const filled = substitute(pattern, request);
      return filled !== undefined && actionMatches(filled, resource.id);
    });
    if (!hit) return false;
  }
  for (const [key, expected] of Object.entries(statement.conditions ?? {})) {
    // Keys like action names; values compared exactly (ids, flags).
    const actual = attributeValues(Object.entries(resource.attributes).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1]);
    const wanted = toList(expected).map((v) => substitute(v, request));
    if (wanted.some((v) => v === undefined)) return false;
    if (!actual.some((a) => wanted.includes(a))) return false;
  }
  return true;
}

const metaOf = (infoOf: ActionInfoOf, action: string): ActionMeta => {
  const info = infoOf(action);
  return typeof info === "string" ? { kind: info } : (info ?? {});
};

function applies(statement: PolicyStatement, action: string, meta: ActionMeta, request: PolicyRequest): boolean {
  if (statement.kind && meta.kind !== statement.kind) return false;
  if (statement.notActions?.some((pattern) => actionMatches(pattern, action))) return false;
  if (!statement.actions.some((pattern) => actionMatches(pattern, action))) return false;
  if (!isScoped(statement)) return true;
  if (request.resource) return recordMatches(statement, request.resource, request);
  // The operation as a whole: a scoped allow lets a record-checking operation run.
  return statement.effect === "allow" && meta.resource !== undefined;
}

/** Allowed when some statement allows `action` (on `request.resource`, if given) and none denies it. */
export function evaluate(statements: readonly PolicyStatement[], action: string, infoOf: ActionInfoOf = () => undefined, request: PolicyRequest = {}): boolean {
  const meta = metaOf(infoOf, action);
  let allowed = false;
  for (const statement of statements) {
    if (!applies(statement, action, meta, request)) continue;
    if (statement.effect === "deny") return false;
    allowed = true;
  }
  return allowed;
}

/** Whether some statement explicitly denies `action` - the only thing that refuses a `self-service` action. */
export function isDenied(statements: readonly PolicyStatement[], action: string, infoOf: ActionInfoOf = () => undefined, request: PolicyRequest = {}): boolean {
  const meta = metaOf(infoOf, action);
  return statements.some((statement) => statement.effect === "deny" && applies(statement, action, meta, request));
}

/** Problems that would make a statement silently never match; empty when it's fine. For saving policies. */
export function statementProblems(statement: PolicyStatement): string[] {
  const problems: string[] = [];
  const texts = [...(statement.resources ?? []), ...Object.values(statement.conditions ?? {}).flatMap(toList)];
  for (const text of texts) {
    for (const [, name] of text.matchAll(VARIABLE)) {
      if (!(POLICY_VARIABLES as readonly string[]).includes(name!)) problems.push(`unknown variable \${${name}} (known: ${POLICY_VARIABLES.map((v) => `\${${v}}`).join(", ")})`);
    }
  }
  for (const pattern of statement.resources ?? []) {
    if (pattern !== "*" && !/^[^:/]+:[^:/]+\/.+$/.test(pattern)) problems.push(`resource "${pattern}" should look like module:type/id (wildcards allowed)`);
  }
  for (const key of Object.keys(statement.conditions ?? {})) {
    if (!/^[^:]+:[^:]+$/.test(key)) problems.push(`condition key "${key}" should look like module:attribute`);
  }
  return problems;
}

/** Policies every IAM install has. They can't be edited or deleted. */
export const MANAGED_POLICIES: Readonly<Record<string, { description: string; document: PolicyDocument }>> = {
  AdministratorAccess: {
    description: "Everything, in every module.",
    document: { version: 1, statements: [{ effect: "allow", actions: ["*"] }] },
  },
  ReadOnlyAccess: {
    description: "Every query (read) in every module except IAM; no commands.",
    document: { version: 1, statements: [{ effect: "allow", actions: ["*"], notActions: ["iam:*"], kind: "query" }] },
  },
};

/** Roles created on first use. Ordinary data afterwards: edit or delete them freely. */
export const STARTER_ROLES: Readonly<Record<string, { description: string; policies: readonly string[] }>> = {
  admin: { description: "Full access.", policies: ["AdministratorAccess"] },
  member: { description: "Can read everything; grant more per module.", policies: ["ReadOnlyAccess"] },
};
