import type { ActionKind } from "../contract.js";

/**
 * AWS IAM, cut down to what modules need. A policy is a list of statements;
 * each allows or denies actions (`module:action`, `*` wildcards anywhere,
 * case-insensitive). An explicit deny beats any allow; anything not allowed
 * is denied. `kind` narrows a statement to queries (reads) or commands
 * (writes), which is how ReadOnlyAccess works without listing every query;
 * `notActions` carves out exceptions.
 *
 * `resources` is reserved for record-level rules. Only `"*"` exists today:
 * a statement naming anything else doesn't apply, so stored policies stay
 * valid when resources arrive.
 */
export interface PolicyStatement {
  readonly effect: "allow" | "deny";
  readonly actions: string[];
  /** Exceptions to `actions` (AWS's NotAction): `actions: ["*"], notActions: ["iam:*"]` is everything but IAM. */
  readonly notActions?: string[];
  readonly kind?: "query" | "command";
  readonly resources?: string[];
}

export interface PolicyDocument {
  readonly version: 1;
  readonly statements: PolicyStatement[];
}

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

function applies(statement: PolicyStatement, action: string, kindOf: (action: string) => ActionKind | undefined): boolean {
  if (statement.resources && !statement.resources.includes("*")) return false;
  if (statement.kind && kindOf(action) !== statement.kind) return false;
  if (statement.notActions?.some((pattern) => actionMatches(pattern, action))) return false;
  return statement.actions.some((pattern) => actionMatches(pattern, action));
}

/** Allowed when some statement allows `action` and none denies it. */
export function evaluate(
  statements: readonly PolicyStatement[],
  action: string,
  kindOf: (action: string) => ActionKind | undefined = () => undefined,
): boolean {
  let allowed = false;
  for (const statement of statements) {
    if (!applies(statement, action, kindOf)) continue;
    if (statement.effect === "deny") return false;
    allowed = true;
  }
  return allowed;
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
