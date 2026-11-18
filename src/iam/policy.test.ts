import { describe, expect, it } from "vitest";
import { MANAGED_POLICIES, actionMatches, evaluate, type PolicyStatement } from "./policy.js";

const kinds: Record<string, "query" | "command"> = { "notes:list": "query", "notes:create": "command", "people:get": "query" };
const kindOf = (a: string) => kinds[a];

describe("policy evaluation", () => {
  it("matches wildcards anywhere, case-insensitively", () => {
    expect(actionMatches("*", "notes:list")).toBe(true);
    expect(actionMatches("notes:*", "notes:create")).toBe(true);
    expect(actionMatches("notes:*", "people:get")).toBe(false);
    expect(actionMatches("*:list", "notes:list")).toBe(true);
    expect(actionMatches("Notes:List", "notes:list")).toBe(true);
    expect(actionMatches("notes:li", "notes:list")).toBe(false);
    expect(actionMatches("notes.list", "notesXlist")).toBe(false); // regex characters are literal
  });

  it("denies by default, allows on a matching allow, and lets an explicit deny win", () => {
    const allowNotes: PolicyStatement = { effect: "allow", actions: ["notes:*"] };
    const denyCreate: PolicyStatement = { effect: "deny", actions: ["notes:create"] };
    expect(evaluate([], "notes:list")).toBe(false);
    expect(evaluate([allowNotes], "notes:create")).toBe(true);
    expect(evaluate([allowNotes, denyCreate], "notes:create")).toBe(false);
    expect(evaluate([denyCreate, allowNotes], "notes:list")).toBe(true);
  });

  it("narrows statements by kind, which is how ReadOnlyAccess works", () => {
    const readOnly = MANAGED_POLICIES.ReadOnlyAccess!.document.statements;
    expect(evaluate(readOnly, "notes:list", kindOf)).toBe(true);
    expect(evaluate(readOnly, "people:get", kindOf)).toBe(true);
    expect(evaluate(readOnly, "notes:create", kindOf)).toBe(false);
    expect(evaluate(readOnly, "unknown:thing", kindOf)).toBe(false);
    expect(evaluate(readOnly, "iam:users", (a) => (a === "iam:users" ? "query" : kindOf(a)))).toBe(false); // IAM is carved out
  });

  it("ignores statements limited to specific resources, until resources exist", () => {
    expect(evaluate([{ effect: "allow", actions: ["*"], resources: ["note/5"] }], "notes:list")).toBe(false);
    expect(evaluate([{ effect: "allow", actions: ["*"], resources: ["*"] }], "notes:list")).toBe(true);
  });
});
