// Purely observational controller presentation and invariant diagnostics.
// Durable controller mutations and historical event semantics remain untouched.
import { join } from "node:path"
import { readLog, validateLog } from "./event-log.js"
import { project, deriveBudget } from "./state.js"
import { blockerFingerprint, applicableAuthority } from "./process-recovery.js"
import { recoveryAction } from "./progress.js"
import { inspectAuthorityGap } from "./authority-triage.js"
import { wuBudgetUsage } from "./wu-budget.js"
import { classifyScopeBlocker } from "./scope-recovery.js"
import { stableHash } from "./serialize.js"
import { DISPATCH_STATUS, RESERVATION_STATUS } from "./constants.js"

// Read-only summary of the projected state + derived budget + dispatch ledger.
export async function summary(controller) {
  const snap = await controller.snapshot()
  const { state, lease } = snap
  const budget = deriveBudget(state.budget)
  return {
    execution_id: state.execution_id,
    revision: state.revision,
    budget: {
      total_seconds: budget.total_seconds,
      used_seconds: budget.used_seconds,
      reserved_seconds: budget.reserved_seconds,
      available_seconds: budget.available_seconds,
      exhausted: budget.exhausted,
      overrun: budget.overrun,
      active_phase: state.budget.active_phase,
      active_started_at: state.budget.active_started_at,
    },
    dispatches: Object.entries(state.dispatches).map(([dispatch_id, d]) => ({
      dispatch_id,
      status: d.status,
      session_id: d.session_id ?? null,
      reserved_seconds: d.reserved_seconds,
      reservation_status: d.reservation_status,
      actual_consumption: d.actual_consumption,
      consumption_basis: d.consumption_basis ?? "unsettled",
      runtime_usage: d.usage ?? null,
    })),
    fencing_token: lease?.fencing_token ?? null,
    blocker: state.blocker,
    blocker_fingerprint: state.blocker ? blockerFingerprint(state.blocker) : null,
    // Read-only compatibility diagnostics: a historical marker is evidence of
    // an unknown former runtime operation, NOT an approved recovery decision.
    historical_recovery_markers: state.historical_recovery_markers ?? [],
    ...applicableAuthority(state),
    external_wait: state.external_wait ?? null,
    verification_phase: state.verification_phase ?? null,
    next_action: recoveryAction(state),
    authority_triage: inspectAuthorityGap(state),
    last_blocker_resolution: state.last_blocker_resolution ?? null,
    authority_resolutions: state.authority_resolutions ?? {},
    completed: state.completed,
    mandate: state.mandate,
    wu: state.wu,
    staged_wu_contract: state.staged_wu_contract ? {
      wu_id: state.staged_wu_contract.wu_id,
      source_artifact_id: state.staged_wu_contract.source_artifact_id,
      source_record_key: state.staged_wu_contract.contract.source_record_key,
      contract_hash: state.staged_wu_contract.contract.contract_hash,
      source_authority: state.staged_wu_contract.contract.source_authority,
      normalization_required: state.staged_wu_contract.contract.normalization_required,
      staged_at_revision: state.staged_wu_contract.staged_at_revision,
      blocker_at_revision: state.staged_wu_contract.blocker_at_revision,
    } : null,
    wu_budget: state.wu ? wuBudgetUsage(state, state.wu.wu_id) : null,
    time_policy: state.time_policy ?? { mode: "LEGACY_HARD_LIMITS" },
    wu_budget_amendments: state.wu_budget_amendments ?? {},
    contract_status: state.wu?.contract ? (state.wu.contract.normalization_required ? "NORMALIZATION_REQUIRED" : "COMPILED") : "LEGACY_UNBOUND",
    candidates: state.candidates,
    reviews: state.reviews,
    pr_binding: state.pr_binding ?? null,
    pr_bindings: state.pr_bindings ?? {},
    merges: state.merges ?? {},
    ci_evidence: state.ci_evidence ?? {},
    merge: state.merge ?? null,
    checkpoint: state.checkpoint,
  }
}

// Strictly read-only invariant check. Rebuilds the projection from the raw log
// file (bypassing any controller state) and asserts ledger/accounting/lease
// coherence. Used after every restart to prove the durable core is intact.
export async function verify(controller) {
  const snap = await controller.snapshot()
  const { events, state, lease } = snap
  const checks = {}

  // Independent rebuild from the raw log file — proves the projection is
  // derivable from the durable source of truth alone.
  const rawEvents = validateLog(await readLog(join(controller.dir, "events.ndjson")))
  const rebuilt = project(rawEvents)
  checks["projection rebuilds from the raw event log"] = JSON.stringify(rebuilt) === JSON.stringify(state)

  // Reservation aggregate is a projection of live dispatch reservations.
  const activeReservations = Object.values(state.dispatches)
    .filter((d) => d.reservation_status === RESERVATION_STATUS.RESERVED)
    .reduce((sum, d) => sum + d.reserved_seconds, 0)
  checks["reservation aggregate equals active dispatch reservations"] = state.budget.reserved_seconds === activeReservations

  // Terminal dispatch invariants: AMBIGUOUS retains its reservation; RELEASED
  // and RESULT_RECONCILED hold no live reservation (their reservation_status is
  // the authority, not the historical reserved_seconds field).
  checks["terminal dispatches satisfy reservation invariants"] = Object.entries(state.dispatches).every(([, d]) => {
    if (d.status === DISPATCH_STATUS.AMBIGUOUS) return d.reservation_status === RESERVATION_STATUS.RESERVED
    if (d.status === DISPATCH_STATUS.RELEASED) return d.reservation_status === RESERVATION_STATUS.RELEASED
    if (d.status === DISPATCH_STATUS.RESULT_RECONCILED) return d.reservation_status === RESERVATION_STATUS.CONSUMED
    return true
  })

  // Fencing is a positive integer generation.
  checks["fencing token is a positive integer generation"] = Number.isInteger(lease?.fencing_token) && lease?.fencing_token >= 1

  // No duplicate operation_id in the log (idempotency keeps the index conflict-free).
  checks["operation ids are unique in the log"] = new Set(events.map((e) => e.operation_id)).size === events.length

  // Dispatch statuses are valid vocabulary.
  checks["dispatch statuses are valid vocabulary"] = Object.values(state.dispatches).every((d) =>
    Object.values(DISPATCH_STATUS).includes(d.status) && Object.values(RESERVATION_STATUS).includes(d.reservation_status),
  )

  const passed = Object.values(checks).every(Boolean)
  return { passed, checks }
}

export async function auditRecovery(controller) {
  const action = "audit_recovery"
    // A strictly read-only record of the exact historical stop and its frozen
    // predecessor lineage. Checkpoints and summary prose are not authority.
    const snap = await controller.snapshot()
    const state = snap.state
    const blocker = state.blocker ?? null
    const historical = blocker && snap.events.find(e => e.previous_revision === blocker.at_revision)
    const sequence = state.mandate?.wu_sequence ?? []
    const activeIndex = state.wu ? sequence.indexOf(state.wu.wu_id) : -1
    const completed_predecessors = sequence.slice(0, Math.max(0, activeIndex)).map(wu_id => {
      const complete = state.completed_wus?.[wu_id] ?? null
      const candidate_id = complete?.candidate_id ?? null
      const merge = candidate_id
        ? (state.merge?.candidate_id === candidate_id ? state.merge : state.merges?.[candidate_id])
        : null
      return { wu_id, candidate_id, completion_revision: complete?.at_revision ?? null,
        merge_status: merge?.status ?? null, merge_commit_sha: merge?.merge_commit_sha ?? null }
    })
    return {
      action, status: blocker ? "BLOCKER_RECORDED" : "NO_BLOCKER",
      read_only: true, execution_id: state.execution_id, revision: state.revision,
      active_wu_id: state.wu?.wu_id ?? null, blocker,
      blocker_event: historical ? {
        operation_id: historical.operation_id, operation_type: historical.operation_type,
        timestamp: historical.timestamp ?? null,
        previous_revision: historical.previous_revision, next_revision: historical.next_revision,
        body: historical.body, body_hash: stableHash(historical.body ?? null),
      } : null,
      historical_event_matches_blocker: !blocker || (historical?.operation_type === "BLOCK" &&
        historical.body?.class === blocker.class),
      scope_diagnosis: classifyScopeBlocker(blocker),
      completed_predecessors,
      canonical_ledger: { mandate_id: state.mandate?.mandate_id ?? null,
        activated_wu_ids: state.activated_wu_ids,
        budget: { total_seconds: state.budget.total_seconds, used_seconds: state.budget.used_seconds,
          reserved_seconds: state.budget.reserved_seconds },
        unfinished_dispatches: Object.entries(state.dispatches)
          .filter(([, d]) => !["released", "result_reconciled", "abandoned_reconciled"].includes(d.status))
          .map(([dispatch_id, d]) => ({ dispatch_id, status: d.status })),
      },
    }
}
