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
import { classifyContinuation, hasPendingSupervisorDispatch, routeExecution } from "./workflow-router.js"
import { inspectOrphanBuilderRisk } from "./orphan-circuit-breaker.js"
import { composeSupervisorPrompt } from "./supervisor-prompt.js"

export function createExecutionSupervisor(ctx, projectRoot, {
  enabled = true, now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout,
  orphanRecovery = null, orphanPolicyId = null,
  runtimeStartedAtMs = null,
} = {}) {
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
      const { toolingTriage, contractTriage, scopeTriage } = classifyContinuation(state)
      if (!session || state.completed || (state.blocker && !expiredWait(state) && !toolingTriage && !contractTriage && !scopeTriage) || state.mandate?.authority_kind !== "OWNER_APPROVED_EPIC") { disarm(execution); return false }
      const info = await identity(session)
      if (info.outcome !== "succeeded") { disarm(execution); return false } // never override cancellation or failure
      // Explicit opt-in only: the named policy must be an indexed, hash-verified
      // owner APPROVED bounded recovery decision. This never operates on an
      // apparently live builder or in the absence of a tooling blocker.
      if (orphanRecovery && orphanPolicyId && state.blocker?.class === "BLOCKED_TOOLING" &&
          state.wu && !state.wu.completed) {
        const launched = Object.entries(state.dispatches).filter(([, d]) =>
          d.status === "launched" && d.wu_id === state.wu.wu_id &&
          d.expected_agent === "harness-builder" && d.session_id)
        if (launched.length === 1) {
          const [dispatchId] = launched[0]
          const progressHash = supervisorProgress(state)
          const triageKey = [dispatchId, orphanPolicyId, progressHash].join(":")
          if (!state.orphan_auto_triage?.[triageKey]) {
            let verdict
            try {
              verdict = await orphanRecovery.recoverOrphan({
                execution_id: execution, dispatch_id: dispatchId,
                decision_artifact_id: orphanPolicyId, session_id: session,
              })
            } catch {
              verdict = { status: "ORPHAN_POLICY_UNAVAILABLE" }
            }
            if (verdict?.status === "ABANDONED_RECONCILED" ||
                verdict?.status === "ALREADY_RECONCILED") {
              state = (await c.snapshot()).state
            } else {
              // Durable one-shot refusal. Neither this receipt nor a new
              // supervisor prompt grants relaunch or clearance authority.
              const reasonCode = String(verdict?.status ?? "EVIDENCE_INSUFFICIENT")
                .toUpperCase().replace(/[^A-Z_]/g, "_").slice(0, 80)
              await commit(c, session, "ORPHAN_AUTO_TRIAGE", {
                dispatch_id: dispatchId, wu_id: state.wu.wu_id,
                policy_id: orphanPolicyId, progress_hash: progressHash,
                reason_code: reasonCode, outcome: "REFUSED",
              }, `${execution}:auto-orphan-refusal:${stableHash(triageKey)}`)
              state = (await c.snapshot()).state
            }
          }
        }
      }
      const budget = state.budget
      const wu = state.wu && !state.wu.completed ? wuBudgetUsage(state, state.wu.wu_id) : null
      if (budget.total_seconds - budget.used_seconds <= 0 || (!usesPlanningEstimates(state) && wu?.ceiling_seconds != null && wu.used_seconds >= wu.ceiling_seconds)) return false
      if (state.external_wait) {
        const wait = state.external_wait
        if (wait.kind === "CI_PENDING") {
          // Historical CI waits have no remaining delivery authority. Retire
          // them once under the existing supervisor lease and wake the root
          // without waiting for the obsolete deadline or querying GitHub.
          await commit(c, session, "EXTERNAL_WAIT_END", {
            wait_id: wait.wait_id, outcome: "RESOLVED", recovery_version: 1,
            observation: { classification: "CI_DEPRECATED_NON_AUTHORITATIVE" },
          }, `${wait.wait_id}:end:CI_DEPRECATED`)
          state = (await c.snapshot()).state
        } else {
          if (now() < Date.parse(wait.next_retry_at)) { arm(execution, Date.parse(wait.next_retry_at)); return false }
          disarm(execution)
          if (!wait.due) {
            await commit(c, session, "EXTERNAL_WAIT_DUE", { wait_id: wait.wait_id, attempt: wait.attempt }, `${wait.wait_id}:due:${wait.attempt}`)
            state = (await c.snapshot()).state
          }
        }
      }
      // The stability guard is a *timed dependency*, not a permanent
      // blocker. Observe the same risk as prepare_launch before sending a
      // prompt that would only reserve/reject a worker. Restore this timer on
      // supervisor.resume() after restart, and recheck all durable gates at
      // the due time. No builder is launched by this timer.
      const route = routeExecution(state)
      const stability = inspectOrphanBuilderRisk(state, {
        nowMs: now(), runtimeLoadedAtMs: runtimeStartedAtMs,
      })
      if (route.nextAction === "LAUNCH_ONE_BUILDER" &&
          stability.launch_temporarily_blocked) {
        arm(execution, now() + stability.retry_after_seconds * 1000 + 100)
        return false
      }
      const unsettled = hasPendingSupervisorDispatch(state)
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
        text: composeSupervisorPrompt({ execution, state,
          toolingTriage, contractTriage, scopeTriage, unsettled }) })
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
    status: () => ({ enabled, errors: [...errors], validation: "REAL_PROVIDER_CANARY_REQUIRED",
      autonomous_orphan_recovery: orphanPolicyId ? "OPT_IN_BOUNDED_POLICY" : "DISABLED" }),
  }
}
