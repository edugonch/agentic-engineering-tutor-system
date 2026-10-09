import { usesPlanningEstimates, epicExecutionRemaining } from "./time-policy.js"
import { wuBudgetUsage } from "./wu-budget.js"
// Durable execution controller. This is the Phase 0 seed of the control plane,
// extended in Phase 2 into a recoverable execution machine.
//
// Invariants enforced here:
//   - events.ndjson is the only canonical state; state is always projected.
//   - commits require a valid, unexpired lease held by the calling session.
//   - commits require BOTH holder_session_id and lease_fencing_token, and the
//     token must match the durable token exactly (closes the same-holder
//     re-acquire gap, not just the cross-holder zombie gap).
//   - commits require a matching expected_revision (compare-and-swap).
//   - an operation_id is either replayed (same hash) or conflicts (different hash).
//   - new budget reservations are gated by an authorization ceiling: the ledger
//     may describe debt, but the controller may not authorize new debt.

import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { readLog, writeLog, validateLog } from "./event-log.js"
import { applyEvent, project, deriveBudget } from "./state.js"
import { isLeaseExpired, nextLease, readLease, writeLease } from "./lease.js"
import { stableHash, operationIdentityHash, stableSerialize } from "./serialize.js"
import { withMutex } from "./mutex.js"
import { DISPATCH_STATUS } from "./constants.js"

// Recovery classification is observation only: it never launches, releases,
// reconciles, or mutates. The four canonical categories cover the actionable
// cases; already-resolved terminals are reported separately.
function classifyDispatch(status) {
  switch (status) {
    case DISPATCH_STATUS.RESERVED:
    case DISPATCH_STATUS.PENDING_LAUNCH:
      return "NEVER_LAUNCHED"
    case DISPATCH_STATUS.LAUNCHED:
      return "KNOWN_RUNNING_OR_LAUNCHED"
    case DISPATCH_STATUS.FINISHED:
      return "FINISHED_UNRECONCILED"
    case DISPATCH_STATUS.AMBIGUOUS:
      return "AMBIGUOUS"
    case DISPATCH_STATUS.RESULT_RECONCILED:
      return "RECONCILED"
    case DISPATCH_STATUS.RELEASED:
      return "RELEASED"
    default:
      return "UNKNOWN"
  }
}

// Deterministic reconcile operation identity, so a crash mid-reconcileAll can
// be retried without double consumption. Derived from execution identity,
// dispatch identity, and the (immutable) finished result.
function reconcileOperationId(execution_id, dispatch_id, result) {
  return `${execution_id ?? "execution"}:reconcile:${dispatch_id}:${stableHash(result ?? null)}`
}

// New events carry this marker and hash {operation_type, body, result}.
const OPERATION_HASH_VERSION = 2

// Reused operation_id resolution. For v2 events the identity is a hash over
// {operation_type, body, result}; for legacy (v1) events — which hashed only
// body — compare the fields semantically so a different operation_type with the
// same body can never masquerade as a replay.
function isSameOperation(event, operation) {
  if (event.operation_hash_version === OPERATION_HASH_VERSION) {
    return event.operation_hash === operationIdentityHash(operation)
  }
  return (
    event.operation_type === operation.operation_type &&
    stableSerialize(event.body ?? null) === stableSerialize(operation.body ?? null) &&
    stableSerialize(event.result ?? null) === stableSerialize(operation.result ?? null)
  )
}

export async function createExecutionController({ root, dir, now = () => Date.now(), lease_ttl_ms = 60000 } = {}) {
  const execDir = dir ?? join(root, ".harness", "execution")
  await mkdir(execDir, { recursive: true })
  const logPath = join(execDir, "events.ndjson")
  const leasePath = join(execDir, "lease.json")
  const mutexPath = join(execDir, "mutex.lock")

  const load = async () => {
    const events = validateLog(await readLog(logPath))
    const state = project(events)
    const lease = await readLease(leasePath)
    return { events, state, lease }
  }

  const snapshot = async () => withMutex(mutexPath, load)

  const acquire = async (holder_session_id) =>
    withMutex(mutexPath, async () => {
      const lease = nextLease(await readLease(leasePath), { holder_session_id, now, ttl_ms: lease_ttl_ms })
      await writeLease(leasePath, lease)
      return lease
    })

  const commit = async (operation, { holder_session_id, expected_revision, lease_fencing_token }) =>
    withMutex(mutexPath, async () => {
      const { events, state, lease } = await load()

      if (!lease || isLeaseExpired(lease, now)) {
        throw new Error("No valid execution lease; acquire one before committing.")
      }
      if (lease.holder_session_id !== holder_session_id) {
        throw new Error(`Fencing conflict: lease is held by ${lease.holder_session_id}, not ${holder_session_id}.`)
      }
      if (lease_fencing_token === undefined || lease_fencing_token === null) {
        throw new Error("commit requires lease_fencing_token (the fencing_token from the lease returned by acquire()).")
      }
      if (lease_fencing_token !== lease.fencing_token) {
        throw new Error(`Stale fencing token: current ${lease.fencing_token}, got ${lease_fencing_token}.`)
      }
      if (expected_revision !== state.revision) {
        throw new Error(`Stale revision: expected ${expected_revision}, current ${state.revision}.`)
      }

      const existing = events.find((event) => event.operation_id === operation.operation_id)
      if (existing) {
        if (!isSameOperation(existing, operation)) {
          throw new Error(`Operation ${operation.operation_id} was reused with different content; this is a conflict, not a replay.`)
        }
        return { status: "replayed", revision: state.revision, state, result: existing.result ?? null }
      }

      if (state.completed && !["CHECKPOINT", "DISPATCH_RECONCILE", "DISPATCH_FINISH", "DISPATCH_USAGE", "DISPATCH_HANDOFF", "DISPATCH_RELEASE"].includes(operation.operation_type)) {
        throw new Error("Execution completed: no new work or state mutation is permitted.")
      }

      // Admission only: preserve replay of historical logs. Never create or
      // launch replacement work while this WU has an unresolved launch identity.
      if (["DISPATCH_RESERVE", "DISPATCH_PREPARE", "DISPATCH_LAUNCH_CLAIM"].includes(operation.operation_type)) {
        const target = state.dispatches[operation.body?.dispatch_id]
        const wu = target?.wu_id ?? state.wu?.wu_id ?? null
        const ambiguous = Object.entries(state.dispatches).find(([dispatchID, d]) =>
          dispatchID !== operation.body?.dispatch_id && (d.wu_id ?? null) === wu &&
          (d.status === "ambiguous" || (d.status === "pending_launch" && d.launch_call_id)))
        if (ambiguous) throw new Error(`HARNESS_UNRESOLVED_LAUNCH: recover dispatch ${ambiguous[0]} before authorizing more work for this WU.`)
      }

      // Avoid billing the same worker interval through both phase and dispatch.
      if (["WU_COMPLETE", "COMPLETE"].includes(operation.operation_type) && state.budget.active_phase) throw new Error("Settle the active phase before completion")
      if (["WU_COMPLETE", "COMPLETE"].includes(operation.operation_type) && state.external_wait) throw new Error("Resolve the external wait before completion")
      if (operation.operation_type === "PHASE_START" && operation.body?.source === "runtime.verification") {
        const requested = operation.body.authorized_seconds
        const available = usesPlanningEstimates(state) ? epicExecutionRemaining(state) : Math.min(deriveBudget(state.budget).available_seconds, wuBudgetUsage(state, state.wu?.wu_id).available_seconds ?? 0)
        if (!Number.isFinite(requested) || requested <= 0 || requested > available) throw new Error("BLOCKED_BUDGET: verification allocation changed before admission")
      }
      if (operation.operation_type === "PHASE_START" && operation.body?.phase === "ACTIVE" &&
          Object.values(state.dispatches).some(d => d.reservation_status === "reserved" && d.reserved_seconds > 0)) {
        throw new Error("Billable phase overlaps a dispatch reservation; use dispatch accounting.")
      }
      if (operation.operation_type === "DISPATCH_RESERVE" && (operation.body?.reserved_seconds ?? 0) > 0 && state.budget.active_phase === "ACTIVE") {
        throw new Error("End the billable phase before reserving worker time.")
      }

      // Budget authorization ceiling: the ledger may describe debt (over-budget
      // history is reconstructible), but the controller may not authorize new
      // debt. Only new reservations are gated; reconcile/phase billing are not.
      if (operation.operation_type === "DISPATCH_RESERVE") {
        const requested = operation.body?.reserved_seconds ?? 0
        const available_seconds = usesPlanningEstimates(state) ? epicExecutionRemaining(state) : deriveBudget(state.budget).available_seconds
        if ((usesPlanningEstimates(state) && available_seconds <= 0) || (requested > 0 && requested > available_seconds)) {
          throw new Error(`BLOCKED_BUDGET: requested reservation ${requested} exceeds available ${available_seconds}.`)
        }
      }

      // Admission only: historical reservations still replay unchanged.
      // An amendment adds a WU ceiling without altering Epic accounting.
      const wuId = state.dispatches[operation.body?.dispatch_id]?.wu_id ?? state.wu?.wu_id
      const usage = wuId ? wuBudgetUsage(state, wuId) : null
      if (!usesPlanningEstimates(state) && usage?.ceiling_seconds !== null && usage?.ceiling_seconds !== undefined) {
        if (operation.operation_type === "DISPATCH_RESERVE" && (operation.body?.reserved_seconds ?? 0) > usage.available_seconds) {
          throw new Error("WU_BUDGET_EXHAUSTED: reservation exceeds the amended WU allocation")
        }
        if (["DISPATCH_PREPARE", "DISPATCH_LAUNCH_CLAIM", "DISPATCH_LAUNCH"].includes(operation.operation_type) && usage.available_seconds < 0) {
          throw new Error("WU_BUDGET_EXHAUSTED: amended WU allocation overdrawn")
        }
        if (operation.operation_type === "PHASE_START" && operation.body?.phase === "ACTIVE" && usage.available_seconds <= 0) {
          throw new Error("WU_BUDGET_EXHAUSTED: no allocation for a new billable phase")
        }
      }

      if (usesPlanningEstimates(state)) {
        if (operation.operation_type === "BLOCK" && operation.body?.class === "BUDGET_EXHAUSTED" && epicExecutionRemaining(state) > 0) {
          throw new Error("WU estimates are advisory: do not block or request a WU extension while Epic execution budget remains")
        }
        if (["DISPATCH_PREPARE", "DISPATCH_LAUNCH_CLAIM", "DISPATCH_LAUNCH"].includes(operation.operation_type) || (operation.operation_type === "PHASE_START" && operation.body?.phase === "ACTIVE")) {
          const worker = state.dispatches[operation.body?.dispatch_id]
          if (epicExecutionRemaining(state, { worker }) <= 0) throw new Error("BUDGET_EXHAUSTED: Epic allocation exhausted")
        }
      }

      const event = {
        sequence: events.length + 1,
        event_id: randomUUID(),
        operation_id: operation.operation_id,
        operation_type: operation.operation_type,
        operation_hash_version: OPERATION_HASH_VERSION,
        operation_hash: operationIdentityHash(operation),
        body: operation.body ?? null,
        result: operation.result ?? null,
        previous_revision: state.revision,
        next_revision: state.revision + 1,
        fencing_token: lease.fencing_token,
        timestamp: new Date(now()).toISOString(),
      }

      const nextState = applyEvent(state, event)
      await writeLog(logPath, [...events, event])

      // Advisory only: recovery always projects the log, never trusts this.
      lease.state_revision = nextState.revision
      await writeLease(leasePath, lease)

      return { status: "committed", revision: nextState.revision, state: nextState, event }
    })

  // Reconcile a dispatch after recovery. Never auto-relaunches: it reports
  // status and a conservative verdict so the caller investigates first.
  const reconcileDispatch = async (dispatch_id) =>
    withMutex(mutexPath, async () => {
      const { state } = await load()
      const d = state.dispatches[dispatch_id]
      if (!d) return { dispatch_id, found: false, verdict: "UNKNOWN", status: null, session_id: null }
      return {
        dispatch_id,
        found: true,
        status: d.status,
        session_id: d.session_id ?? null,
        verdict: d.status === DISPATCH_STATUS.FINISHED || d.status === DISPATCH_STATUS.RESULT_RECONCILED ? "COMPLETED" : "UNRESOLVED",
      }
    })

  // Derived authorization view of the budget. Purely diagnostic.
  const budget = async () => {
    const { state } = await withMutex(mutexPath, load)
    return deriveBudget(state.budget)
  }

  // Read-only recovery: replay the log and classify every dispatch into the
  // canonical recovery categories. It never launches, releases, reconciles, or
  // mutates state.
  const recover = async () =>
    withMutex(mutexPath, async () => {
      const { state, lease } = await load()
      const dispatches = Object.entries(state.dispatches).map(([dispatch_id, d]) => ({
        dispatch_id,
        status: d.status,
        session_id: d.session_id ?? null,
        reserved_seconds: d.reserved_seconds,
        reservation_status: d.reservation_status,
        actual_consumption: d.actual_consumption,
        launch_call_id: d.launch_call_id ?? null,
        classification: d.status === DISPATCH_STATUS.PENDING_LAUNCH && d.launch_call_id ? 'AMBIGUOUS' : classifyDispatch(d.status),
      }))
      const byClassification = (value) => dispatches.filter((d) => d.classification === value).map((d) => d.dispatch_id)
      const classification = {
        never_launched: byClassification("NEVER_LAUNCHED"),
        running_or_launched: byClassification("KNOWN_RUNNING_OR_LAUNCHED"),
        finished_unreconciled: byClassification("FINISHED_UNRECONCILED"),
        ambiguous: byClassification("AMBIGUOUS"),
        resolved: {
          reconciled: byClassification("RECONCILED"),
          released: byClassification("RELEASED"),
        },
      }
      return {
        execution_id: state.execution_id,
        revision: state.revision,
        budget: deriveBudget(state.budget),
        blocker: state.blocker,
        fencing_token: lease?.fencing_token ?? null,
        dispatches,
        classification,
        plan: {
          auto_reconcile: classification.finished_unreconciled,
          requires_investigation: classification.ambiguous,
          release_candidates: classification.never_launched,
          running: classification.running_or_launched,
        },
      }
    })

  // Idempotently reconcile every FINISHED dispatch. It never auto-launches
  // (RESERVED/PENDING_LAUNCH), never invents a finish (LAUNCHED), and never
  // touches AMBIGUOUS/RELEASED. Each reconcile uses a deterministic operation_id
  // so a crash mid-run can be retried without double consumption.
  const reconcileAll = async ({ holder_session_id, lease_fencing_token }) => {
    let snap = await snapshot()
    let expected = snap.state.revision
    const finished = Object.entries(snap.state.dispatches).filter(([, d]) => d.status === DISPATCH_STATUS.FINISHED)
    const result = { reconciled: [], errors: [] }
    for (const [dispatch_id, d] of finished) {
      const operation_id = reconcileOperationId(snap.state.execution_id, dispatch_id, d.result)
      try {
        const res = await commit(
          { operation_id, operation_type: "DISPATCH_RECONCILE", body: { dispatch_id } },
          { holder_session_id, expected_revision: expected, lease_fencing_token },
        )
        result.reconciled.push({ dispatch_id, status: res.status })
        expected = res.revision
      } catch (error) {
        result.errors.push({ dispatch_id, error: String(error.message) })
        snap = await snapshot()
        expected = snap.state.revision
      }
    }
    return result
  }

  // Release a provably-never-launched dispatch (RESERVED/PENDING_LAUNCH only;
  // the projection rejects LAUNCHED/FINISHED/AMBIGUOUS/RESULT_RECONCILED). The
  // deterministic operation_id makes a crash-retry idempotent.
  const releaseDispatch = async (dispatch_id, { holder_session_id, lease_fencing_token, expected_revision }) => {
    const snap = await snapshot()
    const operation_id = `${snap.state.execution_id ?? "execution"}:release:${dispatch_id}`
    return commit(
      { operation_id, operation_type: "DISPATCH_RELEASE", body: { dispatch_id } },
      { holder_session_id, expected_revision, lease_fencing_token },
    )
  }

  // Reconcile one FINISHED dispatch by id, using the SAME deterministic
  // operation identity as reconcileAll. Idempotent: a retry replays instead of
  // double-consuming. Never accepts a caller-supplied consumption amount.
  const reconcileOne = async (dispatch_id, { holder_session_id, lease_fencing_token }) => {
    const snap = await snapshot()
    const d = snap.state.dispatches[dispatch_id]
    if (!d) return { dispatch_id, found: false }
    const operation_id = reconcileOperationId(snap.state.execution_id, dispatch_id, d.result)
    const res = await commit(
      { operation_id, operation_type: "DISPATCH_RECONCILE", body: { dispatch_id } },
      { holder_session_id, expected_revision: snap.state.revision, lease_fencing_token },
    )
    return { dispatch_id, found: true, status: res.status }
  }

  // Serialize the authorization check and one bounded remote effect against
  // every local writer. Never call commit/snapshot from inside effect.
  const guardedEffect = async ({ holder_session_id, expected_revision, validate, effect }) =>
    withMutex(mutexPath, async () => {
      const { state, lease } = await load()
      if (!lease || isLeaseExpired(lease, now) || lease.holder_session_id !== holder_session_id)
        throw new Error("Remote effect requires a current execution lease.")
      if (state.revision !== expected_revision) throw new Error("State changed before remote effect; revalidate.")
      if (state.completed) throw new Error("Execution completed.")
      validate(state)
      return effect(state)
    })

  return {
    guardedEffect,
    dir: execDir,
    snapshot,
    acquire,
    commit,
    reconcileDispatch,
    recover,
    reconcileAll,
    reconcileOne,
    releaseDispatch,
    budget,
  }
}
