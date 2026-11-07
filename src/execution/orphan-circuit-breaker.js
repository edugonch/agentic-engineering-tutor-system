// Failure containment for repeated, durably reconciled orphan *builders*.
//
// This does not infer that OpenCode restarted. It only observes immutable
// abandonment receipts. An unstable runtime can otherwise burn the Epic budget
// by immediately starting new builders after every conservative settlement.
// No ledger, authorization, worker or dispatch is changed by this assessment.
export const ORPHAN_BUILDER_THRESHOLD = 2
export const STABLE_RUNTIME_WINDOW_MS = 30 * 60 * 1000

export function inspectOrphanBuilderRisk(state, {
  nowMs = Date.now(), runtimeLoadedAtMs = null,
} = {}) {
  const wuId = state.wu?.completed ? null : state.wu?.wu_id
  const matching = Object.entries(state.dispatches ?? {}).filter(([, d]) =>
    wuId && d.wu_id === wuId && d.expected_agent === "harness-builder" &&
    d.status === "abandoned_reconciled")
  const charges = matching.reduce((n, [, d]) => n + (Number.isFinite(d.actual_consumption)
    ? d.actual_consumption : (d.reserved_seconds ?? 0)), 0)
  const lastFenceAtMs = Math.max(0, ...matching.map(([, d]) =>
    Date.parse(d.fence?.timestamp ?? "") || 0))
  const previousIds = matching.map(([id]) => id)
  const pattern = matching.length >= ORPHAN_BUILDER_THRESHOLD
  const hasRuntimeEvidence = Number.isFinite(runtimeLoadedAtMs) &&
    runtimeLoadedAtMs > 0 && Number.isFinite(nowMs) && nowMs >= runtimeLoadedAtMs
  const runtimeAgeMs = hasRuntimeEvidence ? nowMs - runtimeLoadedAtMs : null
  const cooldownMs = lastFenceAtMs > 0 ? Math.max(0, STABLE_RUNTIME_WINDOW_MS - (nowMs - lastFenceAtMs)) : 0
  const uptimeMs = runtimeAgeMs == null ? 0 : Math.max(0, STABLE_RUNTIME_WINDOW_MS - runtimeAgeMs)
  // No plugin bootstrap evidence means read-only diagnosis only. The runtime
  // entrypoint supplies the locally observed startup time for real launches.
  const blocked = pattern && hasRuntimeEvidence && Math.max(uptimeMs, cooldownMs) > 0
  return {
    wu_id: wuId ?? null,
    abandoned_builder_dispatch_count: matching.length,
    abandoned_builder_dispatch_ids: previousIds,
    conservatively_charged_seconds: charges,
    repeated_interruption_pattern: pattern,
    ...(hasRuntimeEvidence ? {
      launch_temporarily_blocked: blocked,
      runtime_uptime_seconds: Math.floor(runtimeAgeMs / 1000),
      retry_after_seconds: Math.ceil(Math.max(uptimeMs, cooldownMs) / 1000),
    } : {}),
    interruption_cause: "UNVERIFIED",
    // A recent sibling abandonment is not authority to terminate a new child.
    caution: pattern ? "Inspect runtime/time-policy evidence; settle any launched child before relaunching" : null,
  }
}
