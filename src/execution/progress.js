import { expiredWait } from "./external-observation.js"
import { stableHash } from "./serialize.js"
import { isTechnicalWuContractBlocker } from "./jit-contract.js"
import { isStaleWorktreeScopeBlocker } from "./scope-recovery.js"
import { classifyContinuation } from "./workflow-router.js"
// Progress hashes are part of the append-only supervisor protocol. Historical
// SUPERVISOR_CONTINUE / SUPERVISOR_TURN_OBSERVED receipts were committed before
// DISPATCH_RELEASE gained release-provenance fields (PR #100). Those derived
// fields are needed for the safe tooling-recovery predicate, but must NOT
// retroactively change previously committed progress hashes or cause a journal
// replay to fail with "Continuation no longer eligible".
//
// Strip only these two non-semantic annotations from the hash projection.
// Keep them in canonical state for recovery admission and evidence validation.
// Do not weaken the supervisor's exact progress-hash comparisons.
export function dispatchesForProgress(dispatches = {}) {
  return Object.fromEntries(Object.entries(dispatches).map(([id, dispatch]) => {
    if (!Object.hasOwn(dispatch, "released_from_status") &&
        !Object.hasOwn(dispatch, "released_at_revision")) return [id, dispatch]
    const { released_from_status: _from, released_at_revision: _revision, ...original } = dispatch
    return [id, original]
  }))
}

// Deliberately excludes checkpoints, blocker text, leases and revision counters.
function hashExecutionProgress(state, dispatches) {
  return stableHash({ ...(state.process_policy ? { process_policy: state.process_policy, process_recoveries: state.process_recoveries } : {}), ...(state.process_red ? { process_red: state.process_red } : {}), ...(state.time_policy ? { time_policy: state.time_policy } : {}), mandate: state.mandate, wu: state.wu, budget: state.budget,
    dispatches, candidates: state.candidates, reviews: state.reviews,
    ci: state.ci_evidence, binding: state.pr_binding, merge: state.merge, external_wait: state.external_wait })
}
export function executionProgress(state) {
  return hashExecutionProgress(state, dispatchesForProgress(state.dispatches))
}

// Short-lived PR #100 runtime revisions also committed legitimate hashes with
// the release annotations INCLUDED. Only historical journal replay may accept
// this *exact* old algorithm. Fresh operations have one stable hash format.
export function legacyExpandedExecutionProgress(state) {
  return hashExecutionProgress(state, state.dispatches)
}
export function matchesNoProgressEvidence(state, recordedHash) {
  return executionProgress(state) === recordedHash ||
    legacyExpandedExecutionProgress(state) === recordedHash
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
  // A blocker description is not evidence. The exact immutable failed-setup
  // receipt can be validated only by the dedicated retry tool; the pure
  // status projector must never recommend a billable npm retry from prose.

  const actions = { BLOCKED_PROCESS: "start_process_recovery", BLOCKED_AUTHORITY: "resolve_authority_blocker", BUDGET_EXHAUSTED: state.time_policy?.mode === "WU_PLANNING_ESTIMATES" ? null : "adopt_planning_estimates",
    BLOCKED_TOOLING: "clear_blocker", BLOCKED_EXTERNAL_FACT: "clear_blocker", BLOCKED_ARCHITECTURE: "clear_blocker", NO_PROGRESS: "clear_blocker" }
  return { kind: actions[cls] ? "RECOVERABLE_WITH_EVIDENCE" : "OWNER_DECISION_REQUIRED", action: actions[cls] ?? null,
    blocked_at_revision: state.blocker.at_revision,
    condition: cls === "NO_PROGRESS" ? "New durable execution evidence; checkpoints do not count" :
      cls === "BUDGET_EXHAUSTED" ? "Existing owner approval to adopt planning estimates; legacy finite WU extensions use amend_wu_budget. Epic exhaustion requires separate owner authority." :
      cls === "BLOCKED_AUTHORITY" ? "An applicable approved decision; reuse existing authorization" : "Resolve and verify the actual cause; preserve permissions and scope" }
}

function supervisorHashFor(state, progress) {
  const { mode } = classifyContinuation(state)
  return mode === "ORDINARY"
    ? progress
    : stableHash({ phase: mode, progress, blocked_at_revision: state.blocker.at_revision })
}
export function supervisorProgress(state) {
  return supervisorHashFor(state, executionProgress(state))
}
// Replay compatibility is checked against exactly two known, deterministic
// algorithms. A mismatched WU, dispatch status, lease state, or evidence is not
// authorized by the compatibility path. Do not use for fresh commits.
export function historicalSupervisorProgressMatches(state, recordedHash) {
  return supervisorProgress(state) === recordedHash ||
    supervisorHashFor(state, legacyExpandedExecutionProgress(state)) === recordedHash
}
