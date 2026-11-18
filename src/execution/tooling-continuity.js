// Recover only a *settled* tooling interruption, never an uncertain side effect.
// A positive live root-session probe is separately required by the supervisor.
// This is not WU acceptance, a proof of permanent host stability, or permission
// to launch a second worker while the previous worker might still run.
const SETTLED = new Set(["released", "result_reconciled", "abandoned_reconciled"])
const PRODUCT_PROGRESS = new Set([
  "WU_ACTIVATE", "WU_BATCH_CONFIGURE", "FREEZE_CANDIDATE",
  "RECORD_REVIEW", "MERGE_VERIFY", "WU_COMPLETE",
])
export const MAX_TOOLING_CONTINUATIONS_WITHOUT_PRODUCT_PROGRESS = 2

export function inspectToolingContinuity(state, events = []) {
  if (state.blocker?.class !== "BLOCKED_TOOLING") return { allowed: false, reason: "NOT_TOOLING_BLOCKER" }
  if (state.completed || !state.wu || state.wu.completed ||
      state.mandate?.authority_kind !== "OWNER_APPROVED_EPIC")
    return { allowed: false, reason: "NO_ACTIVE_OWNER_AUTHORIZED_WU" }
  if (state.budget?.active_phase || state.verification_phase || state.external_wait)
    return { allowed: false, reason: "ACTIVE_PHASE_OR_EXTERNAL_WAIT" }

  const unsettled = Object.entries(state.dispatches ?? {})
    .filter(([, d]) => !SETTLED.has(d.status)).map(([id]) => id)
  if (unsettled.length > 0)
    return { allowed: false, reason: "UNSETTLED_DISPATCH", dispatch_ids: unsettled }

  // A generic prose BLOCKED_TOOLING note is not recovery evidence. Require
  // at least one real, settled worker/reviewer attempt associated with this
  // active WU, with a recorded launch identity or fenced abandonment. An empty
  // controller or a setup-only failure is *not* enough to auto-clear.
  const priorWorker = Object.values(state.dispatches ?? {}).some(d =>
    d.wu_id === state.wu.wu_id &&
    ["harness-builder", "harness-reviewer"].includes(d.expected_agent) &&
    SETTLED.has(d.status) &&
    (d.status === "abandoned_reconciled" || Boolean(d.session_id || d.launch_call_id)))
  if (!priorWorker) return { allowed: false, reason: "NO_SETTLED_WORKER_ATTEMPT_PROVEN" }

  // No repeated recovery loop after two root resumptions that produced no
  // candidate/review/merge/WU progress. The owner can still clear a blocker
  // through the existing governed tool, with new evidence.
  const lastProgressSequence = Math.max(0, ...events
    .filter(e => PRODUCT_PROGRESS.has(e.operation_type)).map(e => e.sequence))
  const priorResumes = events.filter(e => e.sequence > lastProgressSequence &&
    e.operation_type === "CLEAR_BLOCKER" &&
    e.body?.blocker_class === "BLOCKED_TOOLING" &&
    e.body?.recovery_evidence?.kind === "SETTLED_TOOLING_CONTINUATION").length
  if (priorResumes >= MAX_TOOLING_CONTINUATIONS_WITHOUT_PRODUCT_PROGRESS)
    return { allowed: false, reason: "REPEATED_INTERRUPTION_WITHOUT_PRODUCT_PROGRESS", prior_resumes: priorResumes }

  return {
    allowed: true, reason: "SETTLED_DISPATCHES_AND_NO_ACTIVE_SIDE_EFFECTS",
    wu_id: state.wu.wu_id, blocker_revision: state.blocker.at_revision,
    prior_resumes: priorResumes,
  }
}
