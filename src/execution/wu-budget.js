import { usesPlanningEstimates } from "./time-policy.js"
// WU accounting is derived from settled dispatches and billable phase history.
// Unknown dispatch consumption remains charged at the reservation by reconcile.
export function wuBudgetUsage(state, wuId) {
  let used = state.wu_phase_seconds?.[wuId] ?? 0
  let reserved = 0
  for (const d of Object.values(state.dispatches)) {
    if (d.wu_id !== wuId) continue
    if (d.reservation_status === "consumed") used += d.actual_consumption ?? d.reserved_seconds
    if (d.reservation_status === "reserved") reserved += d.reserved_seconds
  }
  const ceiling = state.wu_budget_amendments?.[wuId]?.ceiling_seconds ?? (state.wu?.wu_id === wuId ? state.wu.contract?.active_seconds : null) ?? null
  return { wu_id: wuId, used_seconds: used, reserved_seconds: reserved, ceiling_seconds: ceiling,
    ...(usesPlanningEstimates(state) ? { time_policy: "planning_estimate", enforced: false,
      estimate_seconds: ceiling, estimate_overrun_seconds: ceiling === null ? null : Math.max(0, used - ceiling) } : {}),
    available_seconds: ceiling === null ? null : ceiling - used - reserved }
}
