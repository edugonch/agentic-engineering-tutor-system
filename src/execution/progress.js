import { expiredWait } from "./external-observation.js"
import { stableHash } from "./serialize.js"
import { DISPATCH_STATUS } from "./constants.js"
import { isTechnicalWuContractBlocker } from "./jit-contract.js"
import { isStaleWorktreeScopeBlocker } from "./scope-recovery.js"

// Deliberately excludes checkpoints, blocker text, leases and revision counters.
export function executionProgress(state) {
  return stableHash({ ...(state.process_policy ? { process_policy: state.process_policy, process_recoveries: state.process_recoveries } : {}), ...(state.process_red ? { process_red: state.process_red } : {}), ...(state.time_policy ? { time_policy: state.time_policy } : {}), mandate: state.mandate, wu: state.wu, budget: state.budget,
    dispatches: state.dispatches, candidates: state.candidates, reviews: state.reviews,
    ci: state.ci_evidence, binding: state.pr_binding, merge: state.merge, external_wait: state.external_wait })
}

function toolingCause(state) {
  // Never derive a cause from the blocker reason text. Use durable structure only.
  if (state.verification_phase) return { kind: "VERIFICATION_IN_PROGRESS", action: "harness_recover_verification", condition: "Observe the existing owner; recovery requires proof of process exit, never duplicate a live command" }
  const entries = Object.entries(state.dispatches)
  const launched = entries.filter(([, d]) => d.status === DISPATCH_STATUS.LAUNCHED)
  if (launched.length > 0) {
    const orphanCandidate = launched.find(([, d]) => !d.handoff && !d.usage)
    if (orphanCandidate) {
      return { kind: "ORPHAN_DISPATCH_CANDIDATE", action: "declare_orphan_dispatch", dispatch_id: orphanCandidate[0],
        condition: "A launched dispatch has no handoff and no usage. Verify identity and inactivity through harness_recover_dispatch_session and harness_read_dispatch_handoff, then declare orphan with durable evidence." }
    }
    return { kind: "LAUNCHED_DISPATCH_UNSETTLED", action: "harness_read_dispatch_handoff",
      condition: "A launched dispatch remains unsettled; read its handoff and verify outcome before any new launch or finish." }
  }
  if (entries.some(([, d]) => d.status === DISPATCH_STATUS.AMBIGUOUS)) {
    return { kind: "AMBIGUOUS_LAUNCH", action: "resolve_ambiguous_launch",
      condition: "A launch claim exists without confirmed child identity; recover exact session identity before proceeding." }
  }
  return { kind: "TOOLING_GENERIC", action: "clear_blocker", condition: "Resolve and verify the actual cause; preserve permissions and scope." }
}

export function recoveryAction(state) {
  if (state.completed) return { kind: "COMPLETE", action: "status" }
  if (state.verification_phase) return { kind: "VERIFICATION_IN_PROGRESS", action: "harness_recover_verification", condition: "Observe the existing owner; recovery requires proof of process exit, never duplicate a live command" }
  const cls = state.blocker?.class
  if (isTechnicalWuContractBlocker(state.blocker) && (!state.wu || state.wu.completed)) return {
    kind: "RECOVERABLE_WITH_MANDATE", action: "derive_and_stage_next_wu_contract",
    blocked_at_revision: state.blocker.at_revision,
    condition: "Compile the exact next frozen DRAFT, stage its mandate-derived contract, and activate; never invent business decisions",
  }
  if (isStaleWorktreeScopeBlocker(state.blocker)) return {
    kind: "RECOVERABLE_WITH_GIT_PROOF", action: "inspect_scope_worktree",
    blocked_at_revision: state.blocker.at_revision,
    condition: "Reconcile only the exact stale-worktree scope discrepancy from verified predecessor Git HEAD and frozen candidate hashes; never generic clear",
  }
  if (expiredWait(state)) return { kind: "REMOTE_OBSERVATION_REQUIRED", action: expiredWait(state).operation, condition: "Observe current exact-head CI/PR; timeout is neither success nor remote failure" }
  if (!cls && state.external_wait) return { kind: "WAITING_EXTERNAL", action: state.external_wait.operation, next_retry_at: state.external_wait.next_retry_at, deadline_at: state.external_wait.deadline_at }
  if (!cls && state.process_recoveries?.[state.wu?.wu_id]?.status === 'REPAIRING') return { kind: 'PROCESS_REPAIR', action: 'recover', condition: 'Continue retrospective validation, exact candidate review and GREEN; no renewed approval under the adopted policy' }
  if (!cls) return { kind: "CONTINUE", action: "recover" }
  if (cls === "BLOCKED_TOOLING") {
    const cause = toolingCause(state)
    return { kind: cause.kind, action: cause.action, dispatch_id: cause.dispatch_id ?? null, blocked_at_revision: state.blocker.at_revision, condition: cause.condition }
  }
  const actions = { BLOCKED_PROCESS: "start_process_recovery", BLOCKED_AUTHORITY: "resolve_authority_blocker", BUDGET_EXHAUSTED: state.time_policy?.mode === "WU_PLANNING_ESTIMATES" ? null : "adopt_planning_estimates",
    BLOCKED_EXTERNAL_FACT: "clear_blocker", BLOCKED_ARCHITECTURE: "clear_blocker", NO_PROGRESS: "clear_blocker" }
  return { kind: actions[cls] ? "RECOVERABLE_WITH_EVIDENCE" : "OWNER_DECISION_REQUIRED", action: actions[cls] ?? null,
    blocked_at_revision: state.blocker.at_revision,
    condition: cls === "NO_PROGRESS" ? "New durable execution evidence; checkpoints do not count" :
      cls === "BUDGET_EXHAUSTED" ? "Existing owner approval to adopt planning estimates; legacy finite WU extensions use amend_wu_budget. Epic exhaustion requires separate owner authority." :
      cls === "BLOCKED_AUTHORITY" ? "An applicable approved decision; reuse existing authorization" : "Resolve and verify the actual cause; preserve permissions and scope" }
}

export function supervisorProgress(state) {
  const toolingTriage = state.blocker?.class === "BLOCKED_TOOLING" && !expiredWait(state)
  const contractTriage = isTechnicalWuContractBlocker(state.blocker) && (!state.wu || state.wu.completed)
  const scopeTriage = isStaleWorktreeScopeBlocker(state.blocker)
  return toolingTriage || contractTriage || scopeTriage
    ? stableHash({ phase: toolingTriage ? "TOOLING_TRIAGE" : contractTriage ? "JIT_CONTRACT" : "SCOPE_WORKTREE_TRIAGE", progress: executionProgress(state), blocked_at_revision: state.blocker.at_revision })
    : executionProgress(state)
}
