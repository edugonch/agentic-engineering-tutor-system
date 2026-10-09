import { stableHash } from "./serialize.js"
import { wuBudgetUsage } from "./wu-budget.js"
import { ExternalWaitError } from "./external-errors.js"
export { ExternalWaitError }

const view = wait => ({ status: "WAITING_EXTERNAL", wait_id: wait.wait_id, operation: wait.operation,
  kind: wait.kind, attempt: wait.attempt, started_at: wait.started_at, next_retry_at: wait.next_retry_at,
  deadline_at: wait.deadline_at, reason: wait.reason })

// Only explicitly typed runtime/remote transients can enter this path. Security,
// permissions, head drift and failed checks remain ordinary errors.
export async function runWithExternalWait({ controller, session_id, operation, run, observeExistingMerge = false, now = () => Date.now(), waitLimitMs }) {
  const commit = async (type, body, key) => {
    const lease = await controller.acquire(session_id), { state } = await controller.snapshot()
    return controller.commit({ operation_type: type, operation_id: key, body },
      { holder_session_id: session_id, expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  let { state } = await controller.snapshot()
  if (state.completed || state.wu?.completed) return run() // allow read-only idempotent merge recovery
  if (state.blocker) {
    if (observeExistingMerge && ["STARTED", "RECORDED", "VERIFIED"].includes(state.merge?.status)) return run()
    throw new Error(`Execution blocked: ${state.blocker.class}`)
  }
  const wu = state.wu && wuBudgetUsage(state, state.wu.wu_id)
  if (state.budget.total_seconds - state.budget.used_seconds <= 0 || (wu?.ceiling_seconds != null && wu.used_seconds >= wu.ceiling_seconds))
    throw new Error("BUDGET_EXHAUSTED: no authorized execution budget remains")
  let wait = state.external_wait
  if (wait && wait.operation !== operation) throw new Error(`WAITING_EXTERNAL: pending operation ${wait.operation} must be resolved first`)
  async function end(outcome) {
    if (wait) await commit("EXTERNAL_WAIT_END", { wait_id: wait.wait_id, outcome }, `${wait.wait_id}:end:${outcome}`)
  }
  if (wait && now() >= Date.parse(wait.deadline_at)) {
    await end("EXPIRED")
    return { status: "BLOCKED_EXTERNAL_FACT", wait_id: wait.wait_id, reason: "External wait deadline reached; inspect the remote condition before recovery" }
  }
  if (wait && now() < Date.parse(wait.next_retry_at)) return view(wait)
  try {
    const result = await run()
    await end("RESOLVED")
    return result
  } catch (error) {
    if (!(error instanceof ExternalWaitError)) { await end("REJECTED"); throw error }
    state = (await controller.snapshot()).state
    if (state.completed || state.blocker) throw error
    // A race must not replace another operation's wait.
    wait = state.external_wait
    if (wait && wait.operation !== operation) throw new Error("Concurrent external wait conflict")
    const started = wait ? Date.parse(wait.started_at) : now()
    const limit = waitLimitMs ?? (state.wu?.contract?.external_wait_seconds ?? 1800) * 1000
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid external wait limit")
    const attempt = (wait?.attempt ?? 0) + 1
    const deadline = wait ? Date.parse(wait.deadline_at) : started + limit
    const body = { wait_id: wait?.wait_id ?? `wait-${stableHash({ operation, revision: state.revision }).slice(0, 32)}`,
      operation, kind: error.kind, reason: error.message.slice(0, 2000), attempt,
      started_at: new Date(started).toISOString(), deadline_at: new Date(deadline).toISOString(),
      next_retry_at: new Date(Math.min(deadline, now() + Math.min(300000, 15000 * 2 ** Math.min(attempt - 1, 5)))).toISOString() }
    await commit("EXTERNAL_WAIT", body, `${body.wait_id}:attempt:${attempt}`)
    return view(body)
  }
}
