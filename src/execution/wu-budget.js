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
  const ceiling = state.wu_budget_amendments?.[wuId]?.ceiling_seconds ?? null
  return { wu_id: wuId, used_seconds: used, reserved_seconds: reserved, ceiling_seconds: ceiling,
    available_seconds: ceiling === null ? null : ceiling - used - reserved }
}
