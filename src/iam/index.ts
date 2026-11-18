// Browser-safe: the contract and the policy evaluator. Server and React parts
// live in ./server and ./web.
export { iamContract, policyDocumentSchema, policyStatementSchema } from "./contract.js";
export { MANAGED_POLICIES, STARTER_ROLES, actionMatches, evaluate, isDenied, type PolicyDocument, type PolicyStatement } from "./policy.js";
