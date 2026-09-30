// Phase 2 runtime instrument: `harness_execution_controller`.
//
// This is a control surface over the durable execution controller, NOT new
// authority. Every mutating action routes through the controller's `commit()`
// with an `operation_id` + `expected_revision` + `holder_session_id` +
// `lease_fencing_token`; no action ever writes `state.json` or the event log
// directly. The tool is inert unless invoked, and it never touches OpenCode
// configuration, permissions, or agents.
//
// The split between `prepare_launch` and `record_launch` makes the crash window
// observable:
//
//   PENDING_LAUNCH ──external side effect──▶ LAUNCHED (identity persisted)
//
// A crash after the side effect but before `record_launch` is exactly the
// AMBIGUOUS hazard: recovery marks AMBIGUOUS and never auto-launches.

import { join } from "node:path"
import { readLog, validateLog } from "./event-log.js"
import { project, deriveBudget } from "./state.js"
import { createExecutionController } from "./execution.js"
import { DISPATCH_STATUS, RESERVATION_STATUS } from "./constants.js"

function sanitizeId(raw, label) {
  const value = String(raw ?? "")
  const id = value.replace(/[^A-Za-z0-9._-]/g, "_")
  if (!id || id === "." || id === "..") throw new Error(`${label} must be a non-empty identifier that is not '.' or '..'.`)
  return id
}

// Read-only summary of the projected state + derived budget + dispatch ledger.
async function summary(controller) {
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
    },
    dispatches: Object.entries(state.dispatches).map(([dispatch_id, d]) => ({
      dispatch_id,
      status: d.status,
      session_id: d.session_id ?? null,
      reserved_seconds: d.reserved_seconds,
      reservation_status: d.reservation_status,
      actual_consumption: d.actual_consumption,
    })),
    fencing_token: lease?.fencing_token ?? null,
    blocker: state.blocker,
    completed: state.completed,
    wu: state.wu,
    candidates: state.candidates,
    reviews: state.reviews,
    checkpoint: state.checkpoint,
  }
}

// Strictly read-only invariant check. Rebuilds the projection from the raw log
// file (bypassing any controller state) and asserts ledger/accounting/lease
// coherence. Used after every restart to prove the durable core is intact.
async function verify(controller) {
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

// A single mutating action routed through commit() with a freshly-acquired
// lease and a freshly-read revision (compare-and-swap still guards races).
async function commitAction(controller, holder, operation_id, operation_type, body) {
  const lease = await controller.acquire(holder)
  const snap = await controller.snapshot()
  const res = await controller.commit(
    { operation_id, operation_type, body },
    { holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token },
  )
  return res
}

export async function runExecutionController(projectRoot, input) {
  const executionId = sanitizeId(input.execution_id, "execution_id")
  const dir = join(projectRoot, ".harness", "execution", "controller", executionId)
  const controller = await createExecutionController({ dir, lease_ttl_ms: 30000 })
  const holder = String(input.session_id ?? `controller:${executionId}`)
  const action = String(input.action ?? "status")

  if (action === "init") {
    const mandateId = String(input.mandate_id ?? `${executionId}-MANDATE-001`)
    const mandateRevision = String(input.mandate_revision ?? "rev-0")
    const totalSeconds = Number(input.total_seconds ?? 60)
    const res = await commitAction(controller, holder, `${executionId}:mandate`, "MANDATE_APPROVE", {
      execution_id: `${executionId}:exec`,
      mandate_id: mandateId,
      mandate_revision: mandateRevision,
      max_wus: Number(input.max_wus ?? 4),
      total_seconds: totalSeconds,
    })
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "activate_wu") {
    const wuId = String(input.wu_id ?? "")
    if (!wuId) throw new Error("activate_wu requires wu_id.")
    const mandateId = String(input.mandate_id ?? "")
    if (!mandateId) throw new Error("activate_wu requires mandate_id (must match the approved mandate).")
    const res = await commitAction(controller, holder, `${executionId}:activate:${wuId}`, "WU_ACTIVATE", { wu_id: wuId, mandate_id: mandateId })
    return { action, commit_status: res.status, wu_id: wuId, ...(await summary(controller)) }
  }

  if (action === "status") {
    return { action, ...(await summary(controller)) }
  }

  if (action === "reserve") {
    const dispatchId = requireDispatchId(input)
    const reserved = Number(input.reserved_seconds)
    if (!Number.isFinite(reserved) || reserved < 0) throw new Error("reserve requires a finite non-negative reserved_seconds.")
    const res = await commitAction(controller, holder, `${executionId}:reserve:${dispatchId}`, "DISPATCH_RESERVE", { dispatch_id: dispatchId, reserved_seconds: reserved })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "prepare_launch") {
    const dispatchId = requireDispatchId(input)
    const res = await commitAction(controller, holder, `${executionId}:prepare:${dispatchId}`, "DISPATCH_PREPARE", { dispatch_id: dispatchId })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "record_launch") {
    const dispatchId = requireDispatchId(input)
    const launchSessionId = String(input.launch_session_id ?? "")
    if (!launchSessionId) throw new Error("record_launch requires launch_session_id (the external identity persisted at launch).")
    const res = await commitAction(controller, holder, `${executionId}:launch:${dispatchId}`, "DISPATCH_LAUNCH", { dispatch_id: dispatchId, session_id: launchSessionId })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "mark_ambiguous") {
    const dispatchId = requireDispatchId(input)
    const res = await commitAction(controller, holder, `${executionId}:ambiguous:${dispatchId}`, "DISPATCH_MARK_AMBIGUOUS", { dispatch_id: dispatchId })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "record_finish") {
    const dispatchId = requireDispatchId(input)
    const result = input.result ?? null
    const res = await commitAction(controller, holder, `${executionId}:finish:${dispatchId}`, "DISPATCH_FINISH", { dispatch_id: dispatchId, result })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "record_candidate") {
    const candidateId = String(input.candidate_id ?? "")
    if (!candidateId) throw new Error("record_candidate requires candidate_id.")
    const manifestHash = String(input.manifest_hash ?? "")
    const treeHash = String(input.tree_hash ?? "")
    if (!manifestHash || !treeHash) throw new Error("record_candidate requires manifest_hash and tree_hash.")
    const res = await commitAction(controller, holder, `${executionId}:candidate:${candidateId}`, "FREEZE_CANDIDATE", { candidate_id: candidateId, manifest_hash: manifestHash, tree_hash: treeHash, manifest: input.manifest ?? null })
    return { action, commit_status: res.status, candidate_id: candidateId, ...(await summary(controller)) }
  }

  if (action === "record_review") {
    const candidateId = String(input.candidate_id ?? "")
    if (!candidateId) throw new Error("record_review requires candidate_id.")
    const res = await commitAction(controller, holder, `${executionId}:review:${candidateId}`, "RECORD_REVIEW", { candidate_id: candidateId, verdict: input.verdict ?? null, candidate_hashes: input.candidate_hashes ?? {}, reviewer: input.reviewer ?? null })
    return { action, commit_status: res.status, candidate_id: candidateId, ...(await summary(controller)) }
  }

  if (action === "checkpoint") {
    const res = await commitAction(controller, holder, `${executionId}:checkpoint`, "CHECKPOINT", { note: input.note ?? null })
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "block") {
    const cls = String(input.class ?? "")
    if (!cls) throw new Error("block requires class (a BLOCKER_CLASSES value).")
    const res = await commitAction(controller, holder, `${executionId}:block`, "BLOCK", { class: cls, reason: input.reason ?? null })
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "complete") {
    const res = await commitAction(controller, holder, `${executionId}:complete`, "COMPLETE", { result: input.result ?? null })
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "reconcile") {
    const dispatchId = requireDispatchId(input)
    const lease = await controller.acquire(holder)
    const result = await controller.reconcileOne(dispatchId, { holder_session_id: holder, lease_fencing_token: lease.fencing_token })
    return { action, dispatch_id: dispatchId, ...result, ...(await summary(controller)) }
  }

  if (action === "release") {
    const dispatchId = requireDispatchId(input)
    const lease = await controller.acquire(holder)
    const snap = await controller.snapshot()
    const res = await controller.releaseDispatch(dispatchId, { holder_session_id: holder, lease_fencing_token: lease.fencing_token, expected_revision: snap.state.revision })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "recover") {
    return { action, ...(await controller.recover()) }
  }

  if (action === "verify") {
    return { action, ...(await verify(controller)), ...(await summary(controller)) }
  }

  throw new Error(`Unknown action: ${action}.`)
}

function requireDispatchId(input) {
  const id = String(input.dispatch_id ?? "")
  if (!id) throw new Error("This action requires dispatch_id.")
  return id
}
