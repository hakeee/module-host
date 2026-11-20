import { describe, expect, it } from "vitest";
import { MANAGED_POLICIES, actionMatches, evaluate, statementProblems, type PolicyStatement } from "./policy.js";

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

describe("record-level rules", () => {
  // clients:get checks records; clients:stats doesn't.
  const info = (a: string) => (a === "clients:get" ? { kind: "query" as const, resource: "clients:client" } : { kind: "query" as const });
  const client = (id: number, trainers: number[] = [], archived = false) => ({
    id: `clients:client/${id}`,
    attributes: { "clients:trainers": trainers, "clients:archived": archived },
  });
  const mine: PolicyStatement = { effect: "allow", actions: ["clients:get"], conditions: { "clients:trainers": "${user.id}" } };

  it("matches resource patterns, with wildcards and ${user.id}", () => {
    const one: PolicyStatement = { effect: "allow", actions: ["clients:get"], resources: ["clients:client/42"] };
    expect(evaluate([one], "clients:get", info, { userId: 2, resource: client(42) })).toBe(true);
    expect(evaluate([one], "clients:get", info, { userId: 2, resource: client(7) })).toBe(false);
    const all: PolicyStatement = { effect: "allow", actions: ["clients:get"], resources: ["clients:client/*"] };
    expect(evaluate([all], "clients:get", info, { userId: 2, resource: client(7) })).toBe(true);
    const self: PolicyStatement = { effect: "allow", actions: ["clients:get"], resources: ["clients:client/${user.id}"] };
    expect(evaluate([self], "clients:get", info, { userId: 7, resource: client(7) })).toBe(true);
    expect(evaluate([self], "clients:get", info, { userId: 8, resource: client(7) })).toBe(false);
  });

  it("matches conditions on attributes: any value equal to any listed value, all keys", () => {
    expect(evaluate([mine], "clients:get", info, { userId: 2, resource: client(1, [2, 3]) })).toBe(true);
    expect(evaluate([mine], "clients:get", info, { userId: 4, resource: client(1, [2, 3]) })).toBe(false);
    const activeMine: PolicyStatement = { ...mine, conditions: { "clients:trainers": "${user.id}", "clients:archived": "false" } };
    expect(evaluate([activeMine], "clients:get", info, { userId: 2, resource: client(1, [2], true) })).toBe(false);
    expect(evaluate([activeMine], "clients:get", info, { userId: 2, resource: client(1, [2], false) })).toBe(true);
    // A missing attribute never matches.
    expect(evaluate([mine], "clients:get", info, { userId: 2, resource: { id: "clients:client/1", attributes: {} } })).toBe(false);
    // Without a caller, ${user.id} can't resolve: no match.
    expect(evaluate([mine], "clients:get", info, { resource: client(1, [2]) })).toBe(false);
  });

  it("lets a scoped allow run a record-checking operation, but nothing else", () => {
    expect(evaluate([mine], "clients:get", info, { userId: 2 })).toBe(true); // the handler checks each record
    const statsMine: PolicyStatement = { ...mine, actions: ["clients:*"] };
    expect(evaluate([statsMine], "clients:stats", info, { userId: 2 })).toBe(false); // doesn't check records: ignored
  });

  it("applies unscoped statements to every record, and a scoped deny only to its records", () => {
    const everyone: PolicyStatement = { effect: "allow", actions: ["clients:*"] };
    const notArchived: PolicyStatement = { effect: "deny", actions: ["clients:get"], conditions: { "clients:archived": "true" } };
    expect(evaluate([everyone, notArchived], "clients:get", info, { userId: 2, resource: client(1, [], true) })).toBe(false);
    expect(evaluate([everyone, notArchived], "clients:get", info, { userId: 2, resource: client(1, [], false) })).toBe(true);
    expect(evaluate([everyone, notArchived], "clients:get", info, { userId: 2 })).toBe(true); // the operation itself still runs
    const denyAll: PolicyStatement = { effect: "deny", actions: ["clients:get"] };
    expect(evaluate([everyone, denyAll], "clients:get", info, { userId: 2, resource: client(1) })).toBe(false);
  });

  it("still accepts a bare kind lookup (the old signature)", () => {
    expect(evaluate([{ effect: "allow", actions: ["*"], kind: "query" }], "notes:list", kindOf)).toBe(true);
  });

  it("finds statements that could never match, for saving", () => {
    expect(statementProblems(mine)).toEqual([]);
    expect(statementProblems({ effect: "allow", actions: ["*"], resources: ["clients:client/${user.name}"] })[0]).toMatch(/unknown variable \$\{user.name\}/);
    expect(statementProblems({ effect: "allow", actions: ["*"], resources: ["client/42"] })[0]).toMatch(/module:type\/id/);
    expect(statementProblems({ effect: "allow", actions: ["*"], conditions: { trainers: "1" } })[0]).toMatch(/module:attribute/);
  });
});
