// Runtime admission for Phase 4 sessions. Never changes permissions/profiles.
// The OpenCode permission system remains authoritative; this only narrows work
// to the durable dispatch/envelope and persists observed denials as BLOCK.
import { basename, join } from 'node:path'
import { controllerStates } from './ownership.js'
import { createExecutionController } from './execution.js'
import { extractControllerInvocation } from './controller-transport.js'
import { CONTROLLER_READ_ACTIONS, controllerMutationDenied } from './controller-authority.js'
import { TERMINAL_BLOCKER_CLASSES } from './constants.js'
import { stableHash, stableSerialize } from './serialize.js'

const READ_ACTIONS = CONTROLLER_READ_ACTIONS
const SETTLEMENT = new Set([...READ_ACTIONS, 'record_finish', 'reconcile', 'release', 'mark_ambiguous', 'checkpoint', 'block'])
const CONTROLLER_DIAGNOSTICS = new Set(['read', 'glob', 'grep', 'harness_check_agent_readiness', 'harness_check_execution_readiness', 'harness_project_status'])

export function createExecutionGuard(root, ctx, { now = () => Date.now() } = {}) {
  const directory = join(root, '.harness/execution/controller')
  let subscriptionError = null
  // Serialize event observations with local admissions. Durable state, not this
  // chain, carries authority across restarts; errors fail closed until restart.
  let observations = Promise.resolve()

  async function ancestors(sessionID) {
    const ids = new Set()
    let id = sessionID
    while (id && !ids.has(id)) {
      ids.add(id)
      if (ids.size > 100) throw new Error('Session ancestry limit exceeded.')
      if (!ctx.session?.get) break
      const response = await ctx.session.get({ sessionID: id })
      id = (response?.data ?? response)?.parentID
    }
    return ids
  }

  async function bindings(sessionID, input = {}) {
    const records = (await controllerStates(directory)).filter(r => r.projection_error || r.state.mandate?.repair_policy)
    if (!records.length) return []
    const ids = await ancestors(sessionID)
    return records.filter(({ dir, state: s, projection_error, legacy_bindings }) => projection_error
      ? input.execution_id === basename(dir) || legacy_bindings.session_ids.some(id => ids.has(id)) || legacy_bindings.wu_ids.includes(input.wu_id)
      : ids.has(s.mandate.controller_session_id) ||
      Object.values(s.dispatches).some(d => ids.has(d.session_id)) ||
      input.execution_id === basename(dir) ||
      (input.candidate_id && s.candidates[input.candidate_id]) ||
      input.wu_id === s.mandate.repair_policy.wu_id)
  }

  async function persistStop(record, sessionID, cls, identity, reason) {
    const core = await createExecutionController({ dir: record.dir })
    const holder = record.state.mandate.controller_session_id
    if (cls === 'BLOCKED_PERMISSION') {
      // Persist first, independent of lease ownership. A failed BLOCK append
      // never removes this fact; readers and core commits enforce it on restart.
      await core.observePermissionRejection({ session_id: sessionID, identity })
      try {
        const lease = await core.acquire(holder)
        await core.reconcilePermissionStops({ holder_session_id: holder, lease_fencing_token: lease.fencing_token })
      } catch (error) {
        if (!/lease|fencing|Stale revision/i.test(String(error.message))) throw error
        // A valid lease holder can deterministically reconcile the same fact.
        // This is persistence deferral, never permission to recover execution.
      }
      return
    }
    const lease = await core.acquire(holder)
    const snap = await core.snapshot()
    if (snap.state.blocker && TERMINAL_BLOCKER_CLASSES.has(snap.state.blocker.class)) return
    const key = stableHash({ sessionID, cls, identity })
    await core.commit({ operation_id: `runtime-stop:${key}`, operation_type: 'BLOCK', body: {
      blocker_id: `runtime-stop:${key}`, class: cls, reason,
      failure_signature: stableHash({ cls, identity }), origin_session_id: sessionID,
      evidence: { source: 'OpenCode runtime', identity },
    } }, { holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token })
  }

  async function commitObservation(record, operation) {
    const core = await createExecutionController({ dir: record.dir })
    const snap = await core.snapshot()
    const holder = snap.lease?.holder_session_id ?? record.state.mandate.controller_session_id
    const lease = await core.acquire(holder)
    return core.commit(operation, { holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token })
  }

  async function rejectPermission(sessionID, identity) {
    for (const record of await bindings(sessionID)) {
      // Invalid pre-Phase-4 history already denies its affected identities in
      // beforeTool and is explicitly exposed by controllerStates. It cannot
      // accept a new Phase-4 BLOCK, but its permission event must not poison the
      // shared observation chain or abort delivery for valid executions.
      if (record.projection_error) continue
      await persistStop(record, sessionID, 'BLOCKED_PERMISSION', identity, 'permission.rejected: no alternate execution permitted')
    }
  }

  function observe(fn) {
    observations = observations.then(fn).catch(error => {
      subscriptionError = String(error.message ?? error)
      throw error
    })
    // Keep rejected chains observed even when event consumers are shutting down.
    observations.catch(() => {})
    return observations
  }

  async function beforeTool(event) {
    await observations
    const normalized = extractControllerInvocation(event)
    const tool = normalized?.tool ?? event.tool
    const input = normalized?.input ?? (event.input ?? {})
    const records = await bindings(event.sessionID, input)
    if (records.length && subscriptionError) throw new Error(`BLOCKED_TOOLING: permission observation unavailable: ${subscriptionError}`)
    for (const record of records) {
      if (record.projection_error) throw new Error(`Historical projection failure: ${record.projection_error}`)
      let s = record.state
      let recoveryClaim = null
      const blocker = record.effective_blocker ?? s.blocker
      const control = tool === 'harness_execution_controller'
      const audit = control && input.execution_id === basename(record.dir) && SETTLEMENT.has(input.action)
      const owner = event.sessionID === s.mandate.controller_session_id
      let dispatch = Object.values(s.dispatches).find(d => d.session_id === event.sessionID)
      if (blocker && TERMINAL_BLOCKER_CLASSES.has(blocker.class)) {
        if (audit && !dispatch) continue
        throw new Error(`Execution blocked by ${blocker.class}; no alternate tool/session/route.`)
      }
      if (control) {
        // Any controller invocation from a session other than the mandate's own
        // controller is a specialist descendant mutating execution authority.
        // Deny it before tool dispatch and lease acquisition, without depending
        // on the specialist's dispatch binding already being visible (the
        // binding and the mutation can arrive in the same assistant turn).
        if (controllerMutationDenied(s, event.sessionID, input.action) || (dispatch && !READ_ACTIONS.has(input.action))) throw new Error('Specialist cannot mutate execution authority.')
        if (input.session_id && input.session_id !== event.sessionID && !READ_ACTIONS.has(input.action)) throw new Error('Controller session identity cannot be supplied by another session.')
        // Controller read tools can be exact approved recovery actions; the general
        // recovery path is skipped for controller tools, so record the claim here.
        if (s.blocker && READ_ACTIONS.has(input.action) && dispatch && dispatch.status === 'launched') {
          const recovery = s.recoveries[s.blocker.blocker_id]
          const dispatchId = Object.entries(s.dispatches).find(([, d]) => d === dispatch)?.[0]
          if (recovery && recovery.dispatch_id === dispatchId && tool === recovery.action.tool && stableSerialize(input) === stableSerialize(recovery.action.input)) {
            if (recovery.action_claim) throw new Error('Recovery action attempt already claimed/consumed; reconcile the same attempt, never repeat it.')
            if (!event.id) throw new Error('Recovery action claim requires a tool call identity.')
            const claim = { operation_id: `recovery-claim:${recovery.authorization_id}`, operation_type: 'CHECKPOINT', body: { recovery_action_claim: { session_id: event.sessionID, action_hash: stableHash(recovery.action), tool_call_id: event.id } } }
            const result = await commitObservation(record, claim)
            if (result.status === 'replayed') throw new Error('Recovery action attempt already claimed; replay is not permission to execute twice.')
          }
        }
        continue
      }
      if (owner && tool === 'subagent') {
        const pending = Object.entries(s.dispatches).filter(([, d]) => d.status === 'pending_launch' && !d.launch_call_id && d.actor === input.agent)
        if (pending.length !== 1) throw new Error('Exactly one unclaimed prepared dispatch is required before subagent launch.')
        const [id] = pending[0]
        await commitObservation(record, { operation_id: `launch-claim:${event.id}`, operation_type: 'CHECKPOINT', body: { launch_claim: { dispatch_id: id, call_id: event.id } } })
        continue
      }
      if (!owner && !dispatch) {
        const parent = await ctx.session.get({ sessionID: event.sessionID })
        const pending = Object.entries(s.dispatches).filter(([, d]) => d.status === 'pending_launch' && d.launch_call_id && d.actor === event.agent)
        if ((parent?.data ?? parent)?.parentID !== s.mandate.controller_session_id || pending.length !== 1) throw new Error('No dispatch authorization for this session.')
        const [id] = pending[0]
        const res = await commitObservation(record, { operation_id: `${basename(record.dir)}:launch:${id}`, operation_type: 'DISPATCH_LAUNCH', body: { dispatch_id: id, session_id: event.sessionID } })
        s = res.state
        dispatch = s.dispatches[id]
      }
      if (owner && !dispatch && tool !== 'harness_run_verification') {
        const freezeAfterHandoff = tool === 'harness_freeze_candidate' && Object.values(s.dispatches).some(d => ['BUILD', 'REPAIR'].includes(d.purpose) && d.status === 'result_reconciled')
        if (!s.blocker && (CONTROLLER_DIAGNOSTICS.has(tool) || freezeAfterHandoff)) continue
        throw new Error('Controller execution requires a funded authorized dispatch; only diagnostics and bookkeeping are unreserved.')
      }
      if (tool === 'harness_run_verification') {
        if (!dispatch || dispatch.status !== 'launched' || !['REVIEW', 'RECOVERY'].includes(dispatch.purpose)) throw new Error('Verification requires a live reserved reviewer/recovery dispatch.')
        if (dispatch.candidate_id !== input.candidate_id) throw new Error('Verification candidate is not bound to this dispatch.')
      }
      if (s.blocker) {
        const recovery = s.recoveries[s.blocker.blocker_id]
        if (!dispatch || dispatch.status !== 'launched' || recovery?.dispatch_id !== Object.entries(s.dispatches).find(([, d]) => d === dispatch)?.[0]) throw new Error('Unresolved blocker permits only its bound recovery dispatch.')
        const check = tool === 'harness_run_verification' && input.verification_check_id === recovery.action.success_check_id
        const exact = tool === recovery.action.tool && stableSerialize(input) === stableSerialize(recovery.action.input)
        if (!check && !exact) throw new Error('Only the exact approved recovery tool/action is authorized; no permission widening.')
        if (check && recovery.action_evidence?.status !== 'PASS') throw new Error('Recovery action is unconfirmed/ambiguous; successful action evidence is required before verification.')
        if (exact) {
          if (recovery.action_claim) throw new Error('Recovery action attempt already claimed/consumed; reconcile the same attempt, never repeat it.')
          if (!event.id) throw new Error('Recovery action claim requires a tool call identity.')
          recoveryClaim = { operation_id: `recovery-claim:${recovery.authorization_id}`, operation_type: 'CHECKPOINT', body: { recovery_action_claim: { session_id: event.sessionID, action_hash: stableHash(recovery.action), tool_call_id: event.id } } }
        }
      }
      if (dispatch) {
        if (dispatch.status !== 'launched') throw new Error('Specialist dispatch is settled or not launched; reservation is not live.')
        if (event.agent && event.agent !== dispatch.actor) throw new Error('Specialist actor differs from the authorized dispatch.')
        if (now() >= Date.parse(dispatch.launch_started_at ?? dispatch.launched_at) + dispatch.reserved_seconds * 1000) {
          await persistStop(record, event.sessionID, 'BUDGET_EXHAUSTED', { dispatch: dispatch.operation_id }, 'Dispatch reservation time exhausted.')
          throw new Error('BUDGET_EXHAUSTED: no further execution.')
        }
        if (['subagent', 'harness_execution_controller', 'harness_freeze_candidate'].includes(tool)) throw new Error('Specialist cannot delegate or change execution authority.')
      }
      if (recoveryClaim) {
        const result = await commitObservation(record, recoveryClaim)
        if (result.status === 'replayed') throw new Error('Recovery action attempt already claimed; replay is not permission to execute twice.')
      }
    }
  }

  const onPermission = (event) => event.effect === 'deny'
    ? observe(() => rejectPermission(event.sessionID, { action: event.action, resources: event.resources, source: event.source ?? null }))
    : Promise.resolve()

  const onEvent = (event) => {
    // V2's public event is permission.replied with reply=reject. The rejection
    // error path is also observed below; neither relies on an invented event.
    if (event.type !== 'permission.replied' || event.data?.reply !== 'reject') return Promise.resolve()
    return observe(() => rejectPermission(event.data.sessionID, { request_id: event.data.requestID }))
  }

  const afterTool = async (event) => {
    const normalized = extractControllerInvocation(event)
    const tool = normalized?.tool ?? event.tool
    const input = normalized?.input ?? (event.input ?? {})
    if (event.status === 'completed' || event.status === 'error') {
      const err = event.error
      if (event.status === 'error' && ([err?.type, err?.code, err?.error?.type, err?.metadata?.type].includes('permission.rejected') || String(err?.message ?? '').includes('permission.rejected'))) {
        return observe(() => rejectPermission(event.sessionID, { tool, call_id: event.id }))
      }
      for (const record of await bindings(event.sessionID, input)) {
        if (record.projection_error) continue
        const s = record.state
        const rec = s.recoveries[s.blocker?.blocker_id]
        if (!rec || rec.action_evidence) continue
        const d = s.dispatches[rec.dispatch_id]
        if (d?.status !== 'launched' || d.session_id !== event.sessionID || tool !== rec.action.tool || stableSerialize(input) !== stableSerialize(rec.action.input)) continue
        await commitObservation(record, { operation_id: `recovery-action:${event.id}`, operation_type: 'CHECKPOINT', body: { recovery_action_evidence: { session_id: event.sessionID, action_hash: stableHash(rec.action), result_hash: stableHash(event.result ?? event.error ?? null), tool_call_id: event.id, status: event.status === 'completed' ? 'PASS' : 'FAIL' } } })
      }
      return
    }
  }

  return { beforeTool, afterTool, onPermission, onEvent, subscriptionFailed: (error) => { subscriptionError = String(error) } }
}
