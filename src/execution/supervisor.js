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
import { isStaleWorktreeScopeBlocker } from "./scope-recovery.js"

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
      const scopeTriage = isStaleWorktreeScopeBlocker(state.blocker)
      if (!session || state.completed || (state.blocker && !expiredWait(state) && !toolingTriage && !contractTriage && !scopeTriage) || state.mandate?.authority_kind !== "OWNER_APPROVED_EPIC") { disarm(execution); return false }
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
      const unsettled = Object.values(state.dispatches).some(d => ["reserved", "pending_launch", "launched", "abandoned", "ambiguous"].includes(d.status))
      // The root may inspect/recover existing work but cannot start duplicates;
      // public controller admission enforces those limits.
      // One diagnostic wake per exact tooling blocker; checkpoints cannot retrigger it.
      const progress = supervisorProgress(state)
      let intent = state.supervisor.intent
      let attempt = 1
      if (intent?.sent && intent.progress_hash === progress) {
        // No speculative relaunch. A sent message can be queued indefinitely.
        // Only an admitted prompt AND observed terminal root turn establishes
        // a genuine no-progress continuation eligible for one bounded retry.
        if (!intent.received || !intent.turn_observed) return false
        if (state.blocker) return false // preserve one-shot tooling/authority triage
        if ((intent.attempt ?? 1) >= 2) {
          await commit(c, session, "BLOCK", { class: "NO_PROGRESS",
            reason: `Orchestrator returned twice after acknowledged supervisor continuations without durable progress; latest intent ${intent.intent_id}, progress ${progress}. Recover with new evidence, not a blind retry.` },
            `${execution}:supervisor-no-progress:${intent.intent_id}`)
          return false
        }
        attempt = (intent.attempt ?? 1) + 1
      }
      if (!intent || intent.sent) {
        const intentID = `msg_harness_${stableHash({ execution, session, progress, attempt }).slice(0, 32)}`
        await commit(c, session, "SUPERVISOR_CONTINUE", { intent_id: intentID, progress_hash: progress, attempt }, `${execution}:continue:${intentID}`)
        state = (await c.snapshot()).state
        intent = state.supervisor.intent
      }
      internal.add(intent.intent_id)
      try {
      await ctx.session.prompt({ sessionID: session, id: intent.intent_id, delivery: "queue", resume: true,
        metadata: { harness_continuation: intent.intent_id, execution_id: execution },
        text: scopeTriage ? `One bounded stale-worktree scope recovery triage for execution ${execution}, blocker at revision ${state.blocker.at_revision}. Do not clear BLOCKED_SCOPE generically, change the original WU scope, or manipulate the journal. Call inspect_scope_worktree, and only if Git HEAD equals the previous verified merge with matching frozen predecessor bytes and no tracked drift, call reconcile_stale_worktree_scope with the current expected_revision and exact blocked_at_revision. Re-read controller status/verify and continue the original WU. If evidence fails, preserve BLOCKED_SCOPE and report the exact mismatch; do not attempt new dispatch or candidate.`
          : contractTriage ? `Next frozen Work Unit technical contract is incomplete for execution ${execution}; blocker revision ${state.blocker.at_revision}. Read status/verify and inspect_next_wu_contract, then derive_and_stage_next_wu_contract using the exact DRAFT source ID and observed revision. This consumes only owner-approved Epic authority under planning estimates; do not assert an individual owner approval. If staging resolves the exact technical blocker, activate the staged WU using the approved mandate, and continue normal verification/review/merge. A product/scope/security/permission blocker remains a hard stop.`
          : toolingTriage ? `One-time tooling diagnosis for execution ${execution}, blocker at revision ${state.blocker.at_revision}. Inspect exact runtime/source facts and recovery audit once. If and ONLY if the blocker concerns an existing frozen verification setup timeout with an immutable FAIL receipt for the exact candidate/check, use harness_retry_blocked_verification once: it runs unchanged frozen setup + declared check with measured budget and may clear only this tooling stop after a full PASS receipt. This governed verification retry is the sole billable exception. Do not invoke a setup id such as install as a declared check. Otherwise remain read-only, and clear only causes independently demonstrably repaired. Never start a new WU, reserve or launch a dispatch, implement new code, change authority or waive review/CI. If outside the mandate, state only the narrow unresolved cause.`
          : `Continue execution ${execution} from operational_status first; use full durable status and verify only for exact receipts/gates under the existing approved mandate. ${expiredWait(state) ? `Observe the remote condition for expired wait ${expiredWait(state).operation}; recovery is read-only until terminal evidence is obtained. Never assume success.` : state.external_wait ? `The durable external wait is due: observe and retry ${state.external_wait.operation}; never assume remote success.` : unsettled ? "Inspect/recover the existing dispatch before any new work." : "Execute the next authorized transition."} Preserve budget, scope, permissions and all evidence. A runtime terminal result is not acceptance. Do not request approvals already applicable. Stop on a real unresolved blocker or completion.` })
      await commit(c, session, "SUPERVISOR_SENT", { intent_id: intent.intent_id }, `${execution}:sent:${intent.intent_id}`)
      } catch (error) {
        internal.delete(intent.intent_id)
        throw error
      }
      return true
    } finally { running.delete(execution) }
  }
  // Session.prompt admission is separate from a queued prompt returning.
  // A durable receipt makes it possible to identify a root turn that completed
  // without executing its pending work, without guessing from elapsed time.
  async function onPrompt(event) {
    if (!enabled) return false
    const token = event.metadata?.harness_continuation ?? event.prompt?.metadata?.harness_continuation
    const execution = event.metadata?.execution_id ?? event.prompt?.metadata?.execution_id
    if (typeof token !== "string" || typeof execution !== "string" || !/^[A-Za-z0-9._-]+$/.test(execution)) return false
    const c = await controller(execution)
    const { state } = await c.snapshot()
    const intent = state.supervisor?.intent
    if (state.supervisor?.session_id !== event.sessionID || !intent || intent.intent_id !== token) return false
    await identity(event.sessionID)
    if (intent.received) return true
    await commit(c, event.sessionID, "SUPERVISOR_RECEIVED",
      { intent_id: token, session_id: event.sessionID, progress_hash: intent.progress_hash },
      `${execution}:received:${token}`)
    return true
  }
  async function observeRootTurn(execution, session) {
    const c = await controller(execution)
    const { state } = await c.snapshot()
    const intent = state.supervisor?.intent
    if (!intent || state.supervisor.session_id !== session || !intent.sent || !intent.received ||
        intent.turn_observed || supervisorProgress(state) !== intent.progress_hash) return
    await commit(c, session, "SUPERVISOR_TURN_OBSERVED",
      { intent_id: intent.intent_id, progress_hash: intent.progress_hash },
      `${execution}:turn-observed:${intent.intent_id}`)
  }
  async function scan(sessionID, { rootTerminal = false } = {}) {
    if (!enabled) return
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) }
    catch (error) { if (error.code === "ENOENT") return; throw error }
    for (const entry of entries.filter(e => e.isDirectory())) {
      try {
        const c = await controller(entry.name)
        const { state } = await c.snapshot()
        if (!sessionID || state.supervisor?.session_id === sessionID) {
          if (rootTerminal && sessionID) await observeRootTurn(entry.name, sessionID)
          await tick(entry.name)
        }
      } catch (error) {
        if (await isValidatedHistoricalTerminal(join(root, entry.name), error)) continue
        errors.push({ execution_id: entry.name, message: error.message })
        if (errors.length > 20) errors.shift()
      }
    }
  }
  return {
    enabled, bind, tick, onPrompt, resume: () => scan(),
    dispose() { for (const execution of timers.keys()) disarm(execution) },
    async onEvent(event) { if (event.type === "session.execution.succeeded" && typeof event.data?.sessionID === "string") await scan(event.data.sessionID, { rootTerminal: true }) },
    isInternalPrompt(event) {
      const token = event.metadata?.harness_continuation ?? event.prompt?.metadata?.harness_continuation
      if (token && internal.has(token)) { internal.delete(token); return true }
      return false
    },
    status: () => ({ enabled, errors: [...errors], validation: "REAL_PROVIDER_CANARY_REQUIRED" }),
  }
}
