// Diagnostic-only history of interrupted/fenced builders.
// Duplicate effects are prohibited by durable dispatch admission and fencing,
// not by assuming that 30 minutes of process uptime proves host stability.
// Keep the former report keys for read-only client compatibility.
export const ORPHAN_BUILDER_THRESHOLD = 2
export const STABLE_RUNTIME_WINDOW_MS = 30 * 60 * 1000 // historical metadata only; never a launch ceiling

export function inspectOrphanBuilderRisk(state, { nowMs = Date.now(), runtimeLoadedAtMs = null } = {}) {
  const wuId = state.wu?.completed ? null : state.wu?.wu_id
  const matching = Object.entries(state.dispatches ?? {}).filter(([, d]) =>
    wuId && d.wu_id === wuId && d.expected_agent === "harness-builder" &&
    d.status === "abandoned_reconciled")
  const charges = matching.reduce((n, [, d]) => n + (Number.isFinite(d.actual_consumption)
    ? d.actual_consumption : (d.reserved_seconds ?? 0)), 0)
  const pattern = matching.length >= ORPHAN_BUILDER_THRESHOLD
  const hasRuntimeEvidence = Number.isFinite(runtimeLoadedAtMs) &&
    runtimeLoadedAtMs > 0 && Number.isFinite(nowMs) && nowMs >= runtimeLoadedAtMs
  return {
    wu_id: wuId ?? null,
    abandoned_builder_dispatch_count: matching.length,
    abandoned_builder_dispatch_ids: matching.map(([id]) => id),
    conservatively_charged_seconds: charges,
    repeated_interruption_pattern: pattern,
    ...(hasRuntimeEvidence ? {
      launch_temporarily_blocked: false,
      runtime_uptime_seconds: Math.floor((nowMs - runtimeLoadedAtMs) / 1000),
      retry_after_seconds: 0,
    } : {}),
    interruption_cause: "UNVERIFIED",
    caution: pattern ? "Review interrupted builders; dispatch fencing and unsettled-child admission remain mandatory" : null,
  }
}
