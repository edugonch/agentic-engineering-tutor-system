// Isolated audit probes: import production code, never touch live project state.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionController } from '../../../../src/execution/execution.js'
import { runExecutionController } from '../../../../src/execution/controller-tool.js'
import { createWorkerBudgetGuard } from '../../../../src/execution/worker-budget.js'
import { runWithExternalWait } from '../../../../src/execution/external-wait.js'
import { compileWuContract } from '../../../../src/execution/wu-contract.js'
import { initialState, applyEvent } from '../../../../src/execution/state.js'
const results = []
const root = await mkdtemp(join(tmpdir(), 'harness-authority-audit-'))
try {
  const c = await createExecutionController({ dir: join(root, '.harness/execution/controller/E') })
  const commit = async (operation_type, body) => {
    const lease = await c.acquire('root'), { state } = await c.snapshot()
    return c.commit({ operation_id: `audit-${state.revision}`, operation_type, body },
      { holder_session_id: 'root', expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  await commit('MANDATE_APPROVE', { execution_id: 'E:exec', mandate_id: 'M', total_seconds: 10000, max_wus: 2,
    time_policy: 'WU_PLANNING_ESTIMATES', authority_kind: 'OWNER_APPROVED_EPIC', source_artifact_id: 'synthetic-epic', source_record_key: 'synthetic-record', source_hash: 'a'.repeat(64) })
  await commit('WU_ACTIVATE', { mandate_id: 'M', wu_id: 'WU066' })
  const tool = (action, extra = {}) => runExecutionController(root, { action, execution_id: 'E', session_id: 'root', ...extra })
  await tool('block', { class: 'BLOCKED_AUTHORITY', reason: 'Implementation preceded RED; no product choice identified' })
  await assert.rejects(tool('clear_blocker', { resolution: 'Run stronger regression and mutation evidence' }), /exact owner-approved decision/)
  results.push({ probe: 'A1', confirmed: true, observation: 'Public tool accepts a process-only authority classification and generic technical recovery is rejected.' })
  const resolveSynthetic = async (label) => {
    const { state } = await c.snapshot()
    // Synthetic reducer fixture, not a claim of real owner approval.
    await commit('AUTHORITY_RESOLVE', { execution_id: 'E', mandate_id: 'M', wu_id: 'WU066', blocked_at_revision: state.blocker.at_revision,
      resolution: label, decision_content: label, source_artifact_id: label, source_record_key: label, source_hash: 'b'.repeat(64) })
  }
  await resolveSynthetic('retrospective-validation-conditions')
  await tool('block', { class: 'BLOCKED_AUTHORITY', reason: 'Seed initial state' })
  await resolveSynthetic('seed-state-conditions')
  await tool('reserve', { dispatch_id: 'D', reserved_seconds: 100 })
  await commit('DISPATCH_PREPARE', { dispatch_id: 'D', prepared_by_session_id: 'root', expected_agent: 'harness-builder', claim_required: true })
  await commit('DISPATCH_LAUNCH_CLAIM', { dispatch_id: 'D', call_id: 'call' })
  await commit('DISPATCH_LAUNCH', { dispatch_id: 'D', session_id: 'child' })
  const guard = createWorkerBudgetGuard({ session: { get: async () => ({ id: 'child', parentID: 'root', agent: 'harness-builder' }), interrupt: async () => assert.fail('Unexpected interruption') } }, root, {})
  try {
    const context = await guard.inspect('child', 'harness-builder')
    assert.equal((await c.snapshot()).state.authority_resolutions.WU066.length, 2)
    assert.equal(context.authority_resolution.resolution, 'seed-state-conditions')
    assert.equal(JSON.stringify(context).includes('retrospective-validation-conditions'), false)
    results.push({ probe: 'A2', confirmed: true, observation: 'Ledger has two resolutions; automatic child context carries only the last one.' })
  } finally { guard.dispose() }
  await tool('record_finish', { dispatch_id: 'D', result: 'synthetic audit fixture' })
  await tool('reconcile', { dispatch_id: 'D' })
  const now = Date.now()
  await commit('EXTERNAL_WAIT', { wait_id: 'wait', operation: 'merge', kind: 'CI_PENDING', reason: 'old pending observation', attempt: 1,
    started_at: new Date(now - 3000).toISOString(), next_retry_at: new Date(now - 2000).toISOString(), deadline_at: new Date(now - 1000).toISOString() })
  let reads = 0
  const wait = await runWithExternalWait({ controller: c, session_id: 'root', operation: 'merge', run: async () => { reads++; return { status: 'SUCCESS' } } })
  assert.equal(reads, 0)
  assert.equal(wait.status, 'BLOCKED_EXTERNAL_FACT')
  results.push({ probe: 'A3', confirmed: true, observation: 'Expired CI wait creates blocker with zero current remote observations.' })
  const compile = obligations => compileWuContract('WU', { content: `execution_contract: ${JSON.stringify({ active_seconds: 2400, process_obligations: obligations })}` })
  assert.equal(compile('not-an-array').process_obligations, 'not-an-array')
  assert.deepEqual(compile([{ arbitrary: 'unrecognized obligation' }]).process_obligations, [{ arbitrary: 'unrecognized obligation' }])
  results.push({ probe: 'A4', confirmed: true, observation: 'Process obligations accept a string and arbitrary objects without semantic/type validation.' })
  let state = initialState()
  state.wu = { wu_id: 'WU', contract: { process_obligations: ['RED before implementation'] } }
  state = applyEvent(state, { operation_type: 'FREEZE_CANDIDATE', body: { candidate_id: 'candidate', wu_id: 'WU', manifest_hash: 'manifest', tree_hash: 'tree', verification_contract_hash: 'contract', required_check_ids: ['tests'] } })
  state = applyEvent(state, { operation_type: 'RECORD_REVIEW', body: { candidate_id: 'candidate', verdict: 'PASS', candidate_hashes: { manifest_hash: 'manifest', tree_hash: 'tree' }, verification_evidence_ids: ['synthetic-green'], verification_contract_hash: 'contract', verified_check_ids: ['tests'] } })
  assert.equal(state.reviews.candidate.verdict, 'PASS')
  results.push({ probe: 'A5', confirmed: true, observation: 'Reducer review gate has no RED-order receipt check. Synthetic reducer inputs are not proof that the public receipt/CI/merge gates can be bypassed.' })
  console.log(JSON.stringify({ baseline: '6cca3cfc22494678e3f69bdb4b2ef691f5812e05', results }, null, 2))
} finally { await rm(root, { recursive: true, force: true }) }
