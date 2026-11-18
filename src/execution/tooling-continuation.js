// Audited, bounded continuation after a *settled* interrupted agent launch.
// This is not proof that the host/network was permanently repaired. It allows
// one new governed attempt only when no earlier side effect can still be live.
// Every automatic clearance is committed with an exact immutable evidence set,
// CAS/fencing, and a per-WU cap. Security, scope, authority, verification,
// ambiguous identity and live-child protections are never bypassed.
import { inspectOrphanBuilderRisk } from "./orphan-circuit-breaker.js"

export const MAX_SETTLED_TOOLING_CONTINUATIONS_PER_WU = 3
export const SETTLED_TOOLING_EVIDENCE_KIND = "SETTLED_DISPATCH_CONTINUATION"
const SETTLED = new Set(["released", "result_reconciled", "abandoned_reconciled"])
const INTERRUPTED = new Set(["released", "abandoned_reconciled"])
const AGENTS = new Set(["harness-builder", "harness-reviewer"])

// A nearby terminal launch receipt is evidence of what was settled, not a
// diagnosis inferred from the model's free-form blocker reason. A distant
// unrelated historical dispatch must not justify clearing a later setup error.
export function inspectSettledToolingContinuation(state, {
  nowMs = Date.now(), runtimeLoadedAtMs = null, requireRuntime = true,
} = {}) {
  const refuse = (reason, extra = {}) => ({ eligible: false, reason, ...extra })
  const blocker = state.blocker
  if (blocker?.class !== "BLOCKED_TOOLING") return refuse("NOT_TOOLING_BLOCKER")
  const wuId = state.wu?.wu_id
  if (state.completed || !wuId || state.wu.completed ||
      state.mandate?.authority_kind !== "OWNER_APPROVED_EPIC") return refuse("NO_ACTIVE_APPROVED_WU")
  if (state.budget?.active_phase || state.verification_phase || state.external_wait)
    return refuse("PHASE_OR_EXTERNAL_EFFECT_UNSETTLED")
  if (Object.values(state.dispatches ?? {}).some(d => !SETTLED.has(d.status)))
    return refuse("UNSETTLED_DISPATCH")
  // An unfinished process repair is a different authority/acceptance issue.
  if (state.process_recoveries?.[wuId]?.status === "REPAIRING")
    return refuse("PROCESS_RECOVERY_PENDING")
  // A failed frozen verification setup must be recovered by its dedicated
  // receipt-bound tool, never by an interrupted-builder continuation.
  if (state.verification_retry?.blocked_at_revision === blocker.at_revision ||
      /(?:\bsetup\b|\bnpm ci\b|verification check|frozen check|\bENOSPC\b|\bsecurity\b|\bpermission\b|\bcredential\b|\bauthority\b)/i.test(blocker.reason ?? ""))
    return refuse("NOT_A_SETTLED_LAUNCH_INCIDENT")

  const previous = state.tooling_continuations?.[wuId] ?? 0
  if (previous >= MAX_SETTLED_TOOLING_CONTINUATIONS_PER_WU)
    return refuse("RETRY_CAP_REACHED", { attempts: previous, max_attempts: MAX_SETTLED_TOOLING_CONTINUATIONS_PER_WU })

  const nearby = Object.entries(state.dispatches ?? {}).filter(([, d]) => {
    if (d.wu_id !== wuId || !AGENTS.has(d.expected_agent) || !INTERRUPTED.has(d.status)) return false
    // An unclaimed RELEASED dispatch has no child side effect.
    // Do not retroactively add a release revision to historical projections.
    if (d.status === "released")
      return d.reservation_status === "released" && !d.launch_call_id
    // For a fenced abandonment, require its exact nearby settlement revision.
    const settledAt = d.reconciled?.at_revision
    return Number.isSafeInteger(settledAt) && settledAt <= blocker.at_revision &&
      settledAt >= blocker.at_revision - 20
  }).map(([dispatchId]) => dispatchId).sort()
  if (!nearby.length) return refuse("NO_RECENT_SETTLED_INTERRUPTION")

  if (requireRuntime) {
    const risk = inspectOrphanBuilderRisk(state, { nowMs, runtimeLoadedAtMs })
    if (risk.launch_temporarily_blocked === undefined)
      return refuse("RUNTIME_OBSERVATION_UNAVAILABLE")
    if (risk.launch_temporarily_blocked)
      return refuse("RUNTIME_COOLDOWN_ACTIVE", { retry_after_seconds: risk.retry_after_seconds })
  }

  return {
    eligible: true, reason: "SETTLED_INTERRUPTION",
    wu_id: wuId, blocked_at_revision: blocker.at_revision,
    dispatch_ids: nearby, attempts: previous, max_attempts: MAX_SETTLED_TOOLING_CONTINUATIONS_PER_WU,
  }
}

export function settledToolingClearBody(state, inspection) {
  if (!inspection?.eligible) throw new Error("Tooling continuation requires independent settled-dispatch evidence")
  return {
    blocker_class: "BLOCKED_TOOLING",
    blocked_at_revision: inspection.blocked_at_revision,
    resolution: "Bounded continuation after exact interrupted dispatches were durably settled; no claim of permanent host repair",
    recovery_evidence: {
      kind: SETTLED_TOOLING_EVIDENCE_KIND,
      wu_id: inspection.wu_id,
      dispatch_ids: inspection.dispatch_ids,
      attempt: inspection.attempts + 1,
    },
  }
}
