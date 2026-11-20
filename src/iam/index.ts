// Browser-safe: the contract and the policy evaluator. Server and React parts
// live in ./server and ./web.
export { iamContract, policyDocumentSchema, policyStatementSchema } from "./contract.js";
export {
  MANAGED_POLICIES,
  POLICY_VARIABLES,
  STARTER_ROLES,
  actionMatches,
  evaluate,
  isDenied,
  isScoped,
  statementProblems,
  type ActionMeta,
  type PolicyDocument,
  type PolicyRequest,
  type PolicyStatement,
} from "./policy.js";
