// One pure, read-only decision point for execution routing.
// This is presentation and scheduling guidance, NOT authorization: every
// mutation continues through the existing controller admission and fences.
import { expiredWait } from "./external-observation.js"
import { isTechnicalWuContractBlocker } from "./jit-contract.js"
import { isStaleWorktreeScopeBlocker } from "./scope-recovery.js"
import { soloCandidateEligible, soloAccepted } from "./solo-delivery.js"

const LIVE = new Set(["reserved", "pending_launch", "launched", "finished", "ambiguous", "abandoned"])
const SETTLED = new Set(["released", "result_reconciled", "abandoned_reconciled"])
// Supervisor continuation historically treats launched/pending/reserved and
// ambiguous/abandoned as in-flight. A finished dispatch is handled separately
// by the reconciliation route; preserve that explicit distinction.
const SUPERVISOR_PENDING = new Set(["reserved", "pending_launch", "launched", "abandoned", "ambiguous"])
export function hasPendingSupervisorDispatch(state) {
  return Object.values(state.dispatches ?? {}).some(d => SUPERVISOR_PENDING.has(d.status))
}

export function classifyContinuation(state) {
  const toolingTriage = state.blocker?.class === "BLOCKED_TOOLING" && !expiredWait(state)
  const contractTriage = isTechnicalWuContractBlocker(state.blocker) && (!state.wu || state.wu.completed)
  const scopeTriage = isStaleWorktreeScopeBlocker(state.blocker)
  const mode = toolingTriage ? "TOOLING_TRIAGE" :
    contractTriage ? "JIT_CONTRACT" : scopeTriage ? "SCOPE_WORKTREE_TRIAGE" : "ORDINARY"
  return { mode, toolingTriage, contractTriage, scopeTriage }
}

export function routeExecution(state, { events = [] } = {}) {
  const wu = state.wu && !state.wu.completed ? state.wu : null
  const wuId = wu?.wu_id ?? null
  const sequence = Array.isArray(state.mandate?.wu_sequence) ? state.mandate.wu_sequence : []
  const activated = new Set(state.activated_wu_ids ?? [])
  const nextWuId = sequence.find(id => !activated.has(id)) ?? null
  const candidates = Object.entries(state.candidates ?? {})
    .filter(([, c]) => c.wu_id === wuId && !c.superseded_by_contract)
  const candidateId = wuId ? candidates.at(-1)?.[0] ?? null : null
  const review = candidateId ? state.reviews?.[candidateId] : null
  const changeRequests = wuId ? Object.entries(state.reviews ?? {}).reduce((n, [id, current]) => {
    if (state.candidates?.[id]?.wu_id !== wuId) return n
    return n + [current, ...(state.review_history?.[id] ?? [])]
      .filter(r => r?.verdict === "CHANGES_REQUIRED").length
  }, 0) : 0
  const dispatches = Object.entries(state.dispatches ?? {}).filter(([, d]) => wuId && d.wu_id === wuId)
  const active = dispatches.filter(([, d]) => LIVE.has(d.status))
  // Terminal status requires all WU dispatches, not only the active WU.
  const unsettled = Object.entries(state.dispatches ?? {}).filter(([, d]) => !SETTLED.has(d.status))
  const lastReviewIndex = [...events].reverse().findIndex(e =>
    e.operation_type === "RECORD_REVIEW" && e.body?.candidate_id === candidateId)
  const reviewSequence = lastReviewIndex < 0 ? null : events[events.length - 1 - lastReviewIndex].sequence
  const builderSettledAfterReview = reviewSequence !== null && events.some(e =>
    e.sequence > reviewSequence && e.operation_type === "DISPATCH_RECONCILE" &&
    state.dispatches?.[e.body?.dispatch_id]?.wu_id === wuId &&
    state.dispatches?.[e.body?.dispatch_id]?.expected_agent === "harness-builder")
  const latestSession = agent => dispatches.filter(([, d]) => d.expected_agent === agent).at(-1)?.[1].session_id ?? null
  const reviewerActive = active.some(([, d]) => d.expected_agent === "harness-reviewer")
  const builderActive = active.some(([, d]) => d.expected_agent === "harness-builder")
  const builderReconciled = dispatches.some(([, d]) =>
    d.expected_agent === "harness-builder" && d.status === "result_reconciled")
  const ambiguous = active.some(([, d]) => ["ambiguous", "abandoned"].includes(d.status))
  const finished = active.some(([, d]) => d.status === "finished")
  const budget = state.budget ?? {}
  const budgetRemaining = [budget.total_seconds, budget.used_seconds, budget.reserved_seconds]
    .every(Number.isFinite)
    ? Math.max(0, budget.total_seconds - budget.used_seconds - budget.reserved_seconds)
    : "UNKNOWN"

  let phase, nextAction
  if (state.completed) {
    phase = "DONE"; nextAction = "NONE"
  } else if (state.blocker) {
    phase = "BLOCKED"; nextAction = "DIAGNOSE_ONCE_OR_STOP"
  } else if (state.mandate?.authority_kind !== "OWNER_APPROVED_EPIC") {
    phase = "BLOCKED"; nextAction = "REQUIRE_APPROVED_EPIC"
  } else if (ambiguous) {
    phase = "BLOCKED"; nextAction = "INSPECT_EXISTING_DISPATCH_ONCE"
  } else if (finished) {
    phase = "BLOCKED"; nextAction = "RECONCILE_FINISHED_DISPATCH"
  } else if (state.verification_phase) {
    phase = "VERIFYING"; nextAction = "OBSERVE_EXISTING_VERIFICATION"
  } else if (reviewerActive) {
    phase = "REVIEWING"; nextAction = "AWAIT_INDEPENDENT_REVIEW"
  } else if (builderActive) {
    phase = "BUILDING"; nextAction = "AWAIT_EXISTING_BUILDER"
  } else if (active.length) {
    phase = "BLOCKED"; nextAction = "INSPECT_EXISTING_DISPATCH_ONCE"
  } else if (budgetRemaining === 0) {
    phase = "BLOCKED"; nextAction = "STOP_EPIC_BUDGET"
  } else if (!wu) {
    phase = "READY"
    nextAction = nextWuId ? "ACTIVATE_NEXT_APPROVED_WU" : "CHECK_EPIC_TERMINAL_CONDITION"
  } else if (review?.verdict === "BLOCKED") {
    phase = "BLOCKED"; nextAction = "DIAGNOSE_ONCE_OR_STOP"
  } else if (review?.verdict === "CHANGES_REQUIRED") {
    if (changeRequests > 2) {
      phase = "BLOCKED"; nextAction = "STOP_REPAIR_LIMIT"
    } else if (builderSettledAfterReview) {
      phase = "REPAIRING"; nextAction = "INSPECT_REPAIR_RESULT_BEFORE_RELAUNCH"
    } else {
      phase = "REPAIRING"; nextAction = "REPAIR_SAME_WU"
    }
  } else if (review?.verdict === "PASS" || (candidateId && soloAccepted(state, candidateId))) {
    phase = "MERGING"
    nextAction = unsettled.length ? "SETTLE_EXISTING_DISPATCH" :
      state.mandate?.merge_policy === "none" ||
      (state.merge?.status === "VERIFIED" && state.merge?.candidate_id === candidateId)
      ? "COMPLETE_WU" : state.mandate?.merge_policy === "human"
        ? "WAIT_FOR_AUTHORIZED_EXTERNAL_MERGE" : "APPLY_GOVERNED_MERGE_GATES"
  } else if (candidateId && soloCandidateEligible(state, candidateId)) {
    phase = "VERIFYING"; nextAction = state.pr_binding?.candidate_id === candidateId
      ? "MERGE_WITH_LOCAL_VERIFICATION" : "BIND_PR_FOR_SOLO_LOCAL"
  } else if (candidateId) {
    phase = "VERIFYING"; nextAction = "VERIFY_THEN_INDEPENDENT_REVIEW"
  } else if (builderReconciled) {
    phase = "BUILDING"; nextAction = "INSPECT_BUILDER_RESULT_BEFORE_RELAUNCH"
  } else {
    phase = "BUILDING"; nextAction = "LAUNCH_ONE_BUILDER"
  }
  return {
    wuId, nextWuId, candidateId, review, changeRequests, unsettledCount: unsettled.length,
    builderSessionId: latestSession("harness-builder"),
    reviewerSessionId: latestSession("harness-reviewer"),
    budgetRemaining, phase, nextAction,
  }
}
