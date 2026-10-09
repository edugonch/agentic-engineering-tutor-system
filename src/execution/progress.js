import { expiredWait } from "./external-observation.js"
import { stableHash } from "./serialize.js"
// Deliberately excludes checkpoints, blocker text, leases and revision counters.
export function executionProgress(state) {
  return stableHash({ ...(state.process_policy ? { process_policy: state.process_policy, process_recoveries: state.process_recoveries } : {}), ...(state.process_red ? { process_red: state.process_red } : {}), ...(state.time_policy ? { time_policy: state.time_policy } : {}), mandate: state.mandate, wu: state.wu, budget: state.budget,
    dispatches: state.dispatches, candidates: state.candidates, reviews: state.reviews,
    ci: state.ci_evidence, binding: state.pr_binding, merge: state.merge, external_wait: state.external_wait })
}
export function recoveryAction(state) {
  if (state.completed) return { kind: "COMPLETE", action: "status" }
  if (state.verification_phase) return { kind: "VERIFICATION_IN_PROGRESS", action: "harness_recover_verification", condition: "Observe the existing owner; recovery requires proof of process exit, never duplicate a live command" }
  const cls = state.blocker?.class
  if (expiredWait(state)) return { kind: "REMOTE_OBSERVATION_REQUIRED", action: expiredWait(state).operation, condition: "Observe current exact-head CI/PR; timeout is neither success nor remote failure" }
  if (!cls && state.external_wait) return { kind: "WAITING_EXTERNAL", action: state.external_wait.operation, next_retry_at: state.external_wait.next_retry_at, deadline_at: state.external_wait.deadline_at }
  if (!cls && state.process_recoveries?.[state.wu?.wu_id]?.status === 'REPAIRING') return { kind: 'PROCESS_REPAIR', action: 'recover', condition: 'Continue retrospective validation, exact candidate review and GREEN; no renewed approval under the adopted policy' }
  if (!cls) return { kind: "CONTINUE", action: "recover" }
  const actions = { BLOCKED_PROCESS: "start_process_recovery", BLOCKED_AUTHORITY: "resolve_authority_blocker", BUDGET_EXHAUSTED: state.time_policy?.mode === "WU_PLANNING_ESTIMATES" ? null : "adopt_planning_estimates",
    BLOCKED_TOOLING: "clear_blocker", BLOCKED_EXTERNAL_FACT: "clear_blocker", BLOCKED_ARCHITECTURE: "clear_blocker", NO_PROGRESS: "clear_blocker" }
  return { kind: actions[cls] ? "RECOVERABLE_WITH_EVIDENCE" : "OWNER_DECISION_REQUIRED", action: actions[cls] ?? null,
    blocked_at_revision: state.blocker.at_revision,
    condition: cls === "NO_PROGRESS" ? "New durable execution evidence; checkpoints do not count" :
      cls === "BUDGET_EXHAUSTED" ? "Existing owner approval to adopt planning estimates; legacy finite WU extensions use amend_wu_budget. Epic exhaustion requires separate owner authority." :
      cls === "BLOCKED_AUTHORITY" ? "An applicable approved decision; reuse existing authorization" : "Resolve and verify the actual cause; preserve permissions and scope" }
}
