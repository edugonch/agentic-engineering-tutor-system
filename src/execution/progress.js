import { stableHash } from "./serialize.js"
// Deliberately excludes checkpoints, blocker text, leases and revision counters.
export function executionProgress(state) {
  return stableHash({ mandate: state.mandate, wu: state.wu, budget: state.budget,
    dispatches: state.dispatches, candidates: state.candidates, reviews: state.reviews,
    ci: state.ci_evidence, binding: state.pr_binding, merge: state.merge })
}
export function recoveryAction(state) {
  if (state.completed) return { kind: "COMPLETE", action: "status" }
  const cls = state.blocker?.class
  if (!cls) return { kind: "CONTINUE", action: "recover" }
  const actions = { BLOCKED_AUTHORITY: "resolve_authority_blocker", BUDGET_EXHAUSTED: "amend_wu_budget",
    BLOCKED_TOOLING: "clear_blocker", BLOCKED_EXTERNAL_FACT: "clear_blocker", BLOCKED_ARCHITECTURE: "clear_blocker", NO_PROGRESS: "clear_blocker" }
  return { kind: actions[cls] ? "RECOVERABLE_WITH_EVIDENCE" : "OWNER_DECISION_REQUIRED", action: actions[cls] ?? null,
    blocked_at_revision: state.blocker.at_revision,
    condition: cls === "NO_PROGRESS" ? "New durable execution evidence; checkpoints do not count" :
      cls === "BLOCKED_AUTHORITY" || cls === "BUDGET_EXHAUSTED" ? "An applicable approved decision; reuse existing authorization" : "Resolve and verify the actual cause; preserve permissions and scope" }
}
