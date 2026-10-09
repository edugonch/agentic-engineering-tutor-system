export const PLANNING_ESTIMATES = "WU_PLANNING_ESTIMATES"
export const usesPlanningEstimates = state => state.time_policy?.mode === PLANNING_ESTIMATES

// Admission view only; never rewrite measured ledger consumption. A running
// worker may exceed its estimate. Account for that elapsed envelope so overruns
// cannot silently create new Epic capacity. The worker's own reservation is not
// subtracted twice from its remaining Epic allocation.
export function epicExecutionRemaining(state, { worker, nowMs = Date.now() } = {}) {
  let remaining = state.budget.total_seconds - state.budget.used_seconds
  if (state.budget.active_phase === "ACTIVE") remaining -= Math.max(0, nowMs / 1000 - state.budget.active_started_at)
  for (const dispatch of Object.values(state.dispatches)) {
    if (dispatch.reservation_status !== "reserved") continue
    const started = Date.parse(dispatch.launch_claimed_at)
    const elapsed = dispatch.usage?.seconds ?? (Number.isFinite(started) ? Math.max(0, (nowMs - started) / 1000) : 0)
    remaining -= dispatch === worker ? elapsed : Math.max(dispatch.reserved_seconds, elapsed)
  }
  return remaining
}
