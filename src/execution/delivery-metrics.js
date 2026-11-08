// Durable productivity signals, not estimates of useful coding time.
// Never labels a worker's billed seconds "productive": only actual accepted
// WU receipts prove delivery, while orphan charges expose lost allocation.
// Read-only; no model tokens, network calls, clock inference, or extra events.
const settled = new Set(["released", "result_reconciled", "abandoned_reconciled"])

export function deliveryMetrics(state) {
  const d = Object.values(state.dispatches ?? {})
  const by = status => d.filter(x => x.status === status)
  const accepted = Object.values(state.completed_wus ?? {})
  const abandoned = by("abandoned_reconciled")
  const reconciled = by("result_reconciled")
  const charged = items => items.reduce((sum, item) => sum + (
    Number.isFinite(item.actual_consumption) && item.actual_consumption >= 0
      ? item.actual_consumption : 0), 0)
  const orphan_seconds = charged(abandoned)
  const reconciled_worker_seconds = charged(reconciled)
  const used = Number.isFinite(state.budget?.used_seconds)
    ? state.budget.used_seconds : null
  const allUnsettled = d.filter(x => !settled.has(x.status))
  const active = state.wu?.completed ? null : state.wu?.wu_id ?? null
  const current = d.filter(x => x.wu_id === active)
  return {
    completed_wu_count: accepted.length,
    total_activated_wu_count: (state.activated_wu_ids ?? []).length,
    accepted_candidate_count: Object.values(state.reviews ?? {}).filter(x => x?.verdict === "PASS").length,
    settled_builder_dispatch_count: reconciled.filter(x => x.expected_agent === "harness-builder").length,
    orphaned_dispatch_count: abandoned.length,
    orphaned_builder_count: abandoned.filter(x => x.expected_agent === "harness-builder").length,
    orphan_conservatively_charged_seconds: orphan_seconds,
    reconciled_dispatch_seconds: reconciled_worker_seconds,
    active_wu_orphan_count: current.filter(x => x.status === "abandoned_reconciled").length,
    unsettled_dispatch_count: allUnsettled.length,
    epic_used_seconds: used,
    ...(used == null ? {} : {
      // This is accounting not attribution: verification phases and other
      // settled periods may be included, so never interpret the remainder as
      // productive engineering.
      remaining_unclassified_seconds: Math.max(0, used - orphan_seconds - reconciled_worker_seconds),
    }),
    productive_engineering_seconds: "UNKNOWN",
    runtime_restart_cause: "UNVERIFIED",
  }
}
