import { expiredWait } from "./external-observation.js"
import { usesPlanningEstimates } from "./time-policy.js"
// Durable continuation outbox. Enabled by default; explicit opt-out remains available.
// It wakes the existing root orchestrator; it never creates/finishes a worker,
// clears a blocker, changes authority, or grants additional budget.
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { createExecutionController } from "./execution.js"
import { isValidatedHistoricalTerminal } from "./historical-terminal.js"
import { supervisorProgress } from "./progress.js"
import { wuBudgetUsage } from "./wu-budget.js"
import { stableHash } from "./serialize.js"
import { isTechnicalWuContractBlocker } from "./jit-contract.js"

export function createExecutionSupervisor(ctx, projectRoot, { enabled = true, now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout } = {}) {
  const running = new Set()
  const internal = new Set()
  const errors = []
  const timers = new Map()
  function disarm(execution) { const timer = timers.get(execution); if (timer !== undefined) cancel(timer); timers.delete(execution) }
  function arm(execution, at) {
    disarm(execution)
    const timer = schedule(() => { timers.delete(execution); tick(execution).catch(error => { errors.push({ execution_id: execution, message: error.message }); if (errors.length > 20) errors.shift() }) }, Math.max(1, Math.min(at - now(), 2_147_483_647)))
    timer?.unref?.()
    timers.set(execution, timer)
  }
  const root = join(projectRoot, ".harness/execution/controller")
  const controller = execution => {
    if (!/^[A-Za-z0-9._-]+$/.test(execution) || [".", ".."].includes(execution)) throw new Error("Invalid supervisor execution")
    return createExecutionController({ dir: join(root, execution) })
  }
  async function commit(c, session, type, body, id) {
    const lease = await c.acquire(session)
    const snap = await c.snapshot()
    return c.commit({ operation_id: id, operation_type: type, body }, {
      holder_session_id: session, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token })
  }
  async function identity(session) {
    const response = await ctx.session.get({ sessionID: session })
    const info = response?.data ?? response
    if (info?.id !== session || info.parentID || info.agent !== "harness-orchestrator") throw new Error("Supervisor requires the actual root orchestrator")
    return info
  }
  async function bind(execution, session) {
    if (!enabled) return
    await identity(session)
    const c = await controller(execution)
    const { state } = await c.snapshot()
    if (state.completed || state.mandate?.authority_kind !== "OWNER_APPROVED_EPIC" || state.supervisor?.session_id === session) return
    await commit(c, session, "SUPERVISOR_BIND", { session_id: session }, `${execution}:supervisor:${session}`)
  }
  async function tick(execution) {
    if (!enabled || running.has(execution)) return false
    running.add(execution)
    try {
      const c = await controller(execution)
      let { state } = await c.snapshot()
      const session = state.supervisor?.session_id
      const toolingTriage = state.blocker?.class === "BLOCKED_TOOLING" && !expiredWait(state)
      const contractTriage = isTechnicalWuContractBlocker(state.blocker) && (!state.wu || state.wu.completed)
      if (!session || state.completed || (state.blocker && !expiredWait(state) && !toolingTriage && !contractTriage) || state.mandate?.authority_kind !== "OWNER_APPROVED_EPIC") { disarm(execution); return false }
      const info = await identity(session)
      if (info.outcome !== "succeeded") { disarm(execution); return false } // never override cancellation or failure
      const budget = state.budget
      const wu = state.wu && !state.wu.completed ? wuBudgetUsage(state, state.wu.wu_id) : null
      if (budget.total_seconds - budget.used_seconds <= 0 || (!usesPlanningEstimates(state) && wu?.ceiling_seconds != null && wu.used_seconds >= wu.ceiling_seconds)) return false
      if (state.external_wait) {
        const wait = state.external_wait
        if (now() < Date.parse(wait.next_retry_at)) { arm(execution, Date.parse(wait.next_retry_at)); return false }
        disarm(execution)
        if (!wait.due) {
          await commit(c, session, "EXTERNAL_WAIT_DUE", { wait_id: wait.wait_id, attempt: wait.attempt }, `${wait.wait_id}:due:${wait.attempt}`)
          state = (await c.snapshot()).state
        }
      }
      const unsettled = Object.values(state.dispatches).some(d => ["reserved", "pending_launch", "launched", "ambiguous"].includes(d.status))
      // The root may inspect/recover existing work but cannot start duplicates;
      // public controller admission enforces those limits.
      // One diagnostic wake per exact tooling blocker; checkpoints cannot retrigger it.
      const progress = supervisorProgress(state)
      let intent = state.supervisor.intent
      if (intent?.sent && intent.progress_hash === progress) return false
      if (!intent || intent.sent) {
        const intentID = `msg_harness_${stableHash({ execution, session, progress }).slice(0, 32)}`
        await commit(c, session, "SUPERVISOR_CONTINUE", { intent_id: intentID, progress_hash: progress }, `${execution}:continue:${intentID}`)
        state = (await c.snapshot()).state
        intent = state.supervisor.intent
      }
      internal.add(intent.intent_id)
      await ctx.session.prompt({ sessionID: session, id: intent.intent_id, delivery: "queue", resume: true,
        metadata: { harness_continuation: intent.intent_id, execution_id: execution },
        text: contractTriage ? `Next frozen Work Unit technical contract is incomplete for execution ${execution}; blocker revision ${state.blocker.at_revision}. Read status/verify and inspect_next_wu_contract, then derive_and_stage_next_wu_contract using the exact DRAFT source ID and observed revision. This consumes only owner-approved Epic authority under planning estimates; do not assert an individual owner approval. If staging resolves the exact technical blocker, activate the staged WU using the approved mandate, and continue normal verification/review/merge. A product/scope/security/permission blocker remains a hard stop.`
          : toolingTriage ? `One-time read-only tooling diagnosis for execution ${execution}, blocker at revision ${state.blocker.at_revision}. Inspect exact runtime/source facts once. If the exact blocker cause is already demonstrably repaired, clear only that recoverable blocker using its exact revision and concrete verification evidence, then return; ordinary authorized continuation will be scheduled separately. Never start a new WU, reserve or launch a dispatch, run billable implementation, change authority, alter the journal, or bypass review during this diagnosis. If repair is outside the frozen mandate, state one narrowly scoped owner decision with the exact failure and proposed repair; do not repeat the request.`
          : `Continue execution ${execution} from durable status and verify under its existing approved mandate. ${expiredWait(state) ? `Observe the remote condition for expired wait ${expiredWait(state).operation}; recovery is read-only until terminal evidence is obtained. Never assume success.` : state.external_wait ? `The durable external wait is due: observe and retry ${state.external_wait.operation}; never assume remote success.` : unsettled ? "Inspect/recover the existing dispatch before any new work." : "Execute the next authorized transition."} Preserve budget, scope, permissions and all evidence. A runtime terminal result is not acceptance. Do not request approvals already applicable. Stop on a real unresolved blocker or completion.` })
      await commit(c, session, "SUPERVISOR_SENT", { intent_id: intent.intent_id }, `${execution}:sent:${intent.intent_id}`)
      return true
    } finally { running.delete(execution) }
  }
  async function scan(sessionID) {
    if (!enabled) return
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) }
    catch (error) { if (error.code === "ENOENT") return; throw error }
    for (const entry of entries.filter(e => e.isDirectory())) {
      try {
        const c = await controller(entry.name)
        const { state } = await c.snapshot()
        if (!sessionID || state.supervisor?.session_id === sessionID) await tick(entry.name)
      } catch (error) {
        if (await isValidatedHistoricalTerminal(join(root, entry.name), error)) continue
        errors.push({ execution_id: entry.name, message: error.message })
        if (errors.length > 20) errors.shift()
      }
    }
  }
  return {
    enabled, bind, tick, resume: () => scan(),
    dispose() { for (const execution of timers.keys()) disarm(execution) },
    async onEvent(event) { if (event.type === "session.execution.succeeded" && typeof event.data?.sessionID === "string") await scan(event.data.sessionID) },
    isInternalPrompt(event) {
      const token = event.metadata?.harness_continuation ?? event.prompt?.metadata?.harness_continuation
      if (token && internal.has(token)) { internal.delete(token); return true }
      return false
    },
    status: () => ({ enabled, errors: [...errors], validation: "REAL_PROVIDER_CANARY_REQUIRED" }),
  }
}
