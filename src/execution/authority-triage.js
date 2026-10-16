import { isTechnicalWuContractBlocker } from "./jit-contract.js"

// Advisory classification only. It is never an authority grant, and it cannot
// clear a hard stop. Explicit typed owner questions outrank text heuristics.
const OWNER_DOMAINS = new Set(["product", "scope", "security", "permission", "budget"])
export function inspectAuthorityGap(state) {
  const blocker = state?.blocker
  if (!blocker) return { status: "NO_AUTHORITY_BLOCKER", can_auto_resolve: false }
  if (blocker.class !== "BLOCKED_AUTHORITY") {
    return { status: "OTHER_BLOCKER", blocker_class: blocker.class, can_auto_resolve: false }
  }
  const question = blocker.authority_question
  if (question?.domain && OWNER_DOMAINS.has(question.domain)) {
    return { status: "BUSINESS_OR_SAFETY_AUTHORITY_REQUIRED", domain: question.domain,
      decision: question.decision ?? null, source_ref: question.source_ref ?? null,
      blocked_at_revision: blocker.at_revision, can_auto_resolve: false,
      next_action: "Find an applicable previously APPROVED decision or ask the actual policy owner" }
  }
  if (isTechnicalWuContractBlocker(blocker) && (!state.wu || state.wu.completed)) {
    return { status: state.time_policy?.mode === "WU_PLANNING_ESTIMATES"
      ? "TECHNICAL_CONTRACT_RECOVERY" : "TIME_POLICY_REQUIRED",
      blocked_at_revision: blocker.at_revision,
      can_auto_resolve: false, next_action: state.time_policy?.mode === "WU_PLANNING_ESTIMATES"
        ? "Inspect exact frozen source and use mandate-derived JIT only if eligible"
        : "Locate existing approved time-policy authority; never presume adoption" }
  }
  return { status: question ? "EXACT_OWNER_DECISION_REQUIRED" : "UNSTRUCTURED_AUTHORITY_STOP",
    blocked_at_revision: blocker.at_revision, domain: question?.domain ?? null,
    decision: question?.decision ?? null, source_ref: question?.source_ref ?? null,
    can_auto_resolve: false,
    next_action: "Read approved sources and existing design proposal, isolate only the policy question; do not clear blocker or invent a product decision" }
}
