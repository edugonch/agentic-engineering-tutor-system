// Durable execution controller. This is the Phase 0 seed of the control plane.
//
// Invariants enforced here:
//   - events.ndjson is the only canonical state; state is always projected.
//   - commits require a valid, unexpired lease held by the calling session.
//   - commits require a matching expected_revision (compare-and-swap).
//   - an operation_id is either replayed (same hash) or conflicts (different hash).
//   - the fencing token is a monotonic generation owned by the lease.

import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { readLog, writeLog, validateLog } from "./event-log.js"
import { applyEvent, project } from "./state.js"
import { isLeaseExpired, nextLease, readLease, writeLease } from "./lease.js"
import { stableHash } from "./serialize.js"
import { withMutex } from "./mutex.js"

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

  return {
    dir: execDir,

    // Project the canonical state (no cached copy is ever trusted).
    async snapshot() {
      return withMutex(mutexPath, load)
    },

    // Acquire or renew the execution lease for a holder session. Renewal by the
    // same holder keeps the fencing token; any transfer increments it.
    async acquire(holder_session_id) {
      return withMutex(mutexPath, async () => {
        const lease = nextLease(await readLease(leasePath), { holder_session_id, now, ttl_ms: lease_ttl_ms })
        await writeLease(leasePath, lease)
        return lease
      })
    },

    // Commit one operation. The caller passes the revision it read from
    // snapshot(); a lost update is rejected by compare-and-swap.
    async commit(operation, { holder_session_id, expected_revision }) {
      return withMutex(mutexPath, async () => {
        const { events, state, lease } = await load()

        if (!lease || isLeaseExpired(lease, now)) {
          throw new Error("No valid execution lease; acquire one before committing.")
        }
        if (lease.holder_session_id !== holder_session_id) {
          throw new Error(`Fencing conflict: lease is held by ${lease.holder_session_id}, not ${holder_session_id}.`)
        }
        if (expected_revision !== state.revision) {
          throw new Error(`Stale revision: expected ${expected_revision}, current ${state.revision}.`)
        }

        const operationHash = stableHash(operation.body ?? null)
        const existing = events.find((event) => event.operation_id === operation.operation_id)
        if (existing) {
          if (existing.operation_hash !== operationHash) {
            throw new Error(`Operation ${operation.operation_id} was reused with different content; this is a conflict, not a replay.`)
          }
          return { status: "replayed", revision: state.revision, state, result: existing.result ?? null }
        }

        const event = {
          sequence: events.length + 1,
          event_id: randomUUID(),
          operation_id: operation.operation_id,
          operation_type: operation.operation_type,
          operation_hash: operationHash,
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
    },

    // Reconcile a dispatch after recovery. Never auto-relaunches: it reports
    // status and a conservative verdict so the caller investigates first.
    async reconcileDispatch(dispatch_id) {
      return withMutex(mutexPath, async () => {
        const { state } = await load()
        const d = state.dispatches[dispatch_id]
        if (!d) return { dispatch_id, found: false, verdict: "UNKNOWN", status: null, session_id: null }
        return {
          dispatch_id,
          found: true,
          status: d.status,
          session_id: d.session_id ?? null,
          verdict: d.status === "finished" ? "COMPLETED" : "UNRESOLVED",
        }
      })
    },
  }
}
