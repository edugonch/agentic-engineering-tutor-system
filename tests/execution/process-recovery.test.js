import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExecutionController } from '../../src/execution/controller-tool.js'
import { createExecutionController } from '../../src/execution/execution.js'
import { recordKnowledgeArtifact } from '../../src/project-knowledge.js'
import { seedWuContract } from './wu-fixture.js'
import { freezeCandidate } from '../../src/execution/candidate.js'
import { createCandidateRegistry } from '../../src/execution/candidate-registry.js'
import { runCandidateVerification } from '../../src/execution/verification.js'
import { createVerificationReceipt, writeVerificationReceipt } from '../../src/execution/verification-results.js'
import { initialState, applyEvent, canStartMerge, canVerifyExternalMerge } from '../../src/execution/state.js'
import { applicableAuthority, assertProcessAcceptance, validateProcessObligations } from '../../src/execution/process-recovery.js'
import { stableHash } from '../../src/execution/serialize.js'
import { runMergeCandidate } from '../../src/execution/merge.js'
import { candidateGitTree } from '../../src/execution/git-tree.js'
import { executionProgress } from '../../src/execution/progress.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'process-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = (action, input = {}) => runExecutionController(root, { execution_id: 'E', session_id: 'root', action, ...input })
  const record = input => recordKnowledgeArtifact(root, { title: 'Owner instruction', status: 'APPROVED', owner_confirmed: true, source_refs: ['https://example.com/owner'], ...input })
  await record({ artifact_type: 'epic', artifact_id: 'epic', content: 'execution_mandate: {"max_wus":2,"total_seconds":10000,"merge_policy":"governed_auto","required_ci_checks":["verify"]}' })
  for (const wu of ['WU1', 'WU2']) await seedWuContract(root, wu, 'epic', 90, { commands: [{ id: 'behavior', program: 'node', args: ['check.cjs'] }], environment: { network_policy: 'UNRESTRICTED' } })
  await run('approve_mandate', { epic_artifact_id: 'epic', mandate_id: 'M' })
  await run('activate_wu', { wu_id: 'WU1', mandate_id: 'M' })
  const dir = join(root, '.harness/execution/controller/E')
  const c = await createExecutionController({ dir })
  const commit = async (operation_type, body) => {
    const lease = await c.acquire('root'), { state } = await c.snapshot()
    return c.commit({ operation_id: `runtime-${state.revision}`, operation_type, body }, { holder_session_id: 'root', expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  const policy = async (overrides = {}, metadata = {}) => record({ artifact_type: 'decision', artifact_id: 'policy', content: 'Owner delegates transparent TDD recovery, GREEN and independent review retained.\nprocess_policy: ' + JSON.stringify({ execution_id: 'E', mandate_id: 'M', scope: 'remaining_epic', recoverable: ['TDD_ORDER'], technical_verification: true, legacy_blocker_hashes: [], ...overrides }), ...metadata })
  const adopt = async overrides => { const a = await policy(overrides); return run('adopt_process_policy', { decision_artifact_id: a.record_key }) }
  const start = () => run('start_process_recovery', { process_kind: 'TDD_ORDER', reason: 'Implementation preceded RED', evidence_ref: 'recorded builder handoff' })
  const candidate = async value => {
    const { state } = await c.snapshot()
    await writeFile(join(root, 'value.json'), JSON.stringify(value))
    await writeFile(join(root, 'check.cjs'), "require('node:assert/strict').equal(require('./value.json'),73)\n")
    const frozen = await freezeCandidate(root, { paths: ['value.json', 'check.cjs'], verification_contract: { ...state.wu.contract.verification_contract, source_wu_id: state.wu.wu_id } })
    await createCandidateRegistry({ dir: join(root, '.harness/execution') }).store(frozen)
    const receipt = createVerificationReceipt(await runCandidateVerification(frozen, 'behavior'))
    await writeVerificationReceipt(join(root, '.harness/execution/verification-results'), receipt)
    return { frozen, receipt }
  }
  const review = async (id, candidate_id, evidence_ids) => {
    await run('reserve', { dispatch_id: id, reserved_seconds: 1 })
    await run('prepare_launch', { dispatch_id: id, launch_agent: 'harness-reviewer', candidate_id })
    await commit('DISPATCH_LAUNCH_CLAIM', { dispatch_id: id, call_id: id })
    await commit('DISPATCH_LAUNCH', { dispatch_id: id, session_id: `child-${id}` })
    const content = 'process_review: ' + JSON.stringify({ verdict: 'PASS', candidate_id, evidence_ids, assessment: 'Count mutation fails an assertion; restored exact candidate passes; deviation explicit' })
    await commit('DISPATCH_HANDOFF', { dispatch_id: id, session_id: `child-${id}`, call_id: id, content, content_hash: stableHash(content), truncated: false })
    await run('record_finish', { dispatch_id: id, result: 'Independent evidence assessment complete' })
    await run('reconcile', { dispatch_id: id })
  }
  return { root, dir, run, record, c, commit, policy, adopt, start, candidate, review }
}

test('one policy supports two WUs, negative execution, fresh review, restart and completion without renewed process approval', async t => {
  const f = await fixture(t)
  await f.adopt()
  for (const [index, wu] of ['WU1', 'WU2'].entries()) {
    if (index) await f.run('activate_wu', { wu_id: wu, mandate_id: 'M' })
    await f.run('block', { class: 'BLOCKED_PROCESS', process_kind: 'TDD_ORDER', reason: 'Builder disclosed deviation' })
    await f.start()
    assert.equal((await f.start()).commit_status, 'replayed')
    const negative = await f.candidate(88), good = await f.candidate(73)
    assert.equal(negative.receipt.status, 'FAIL'); assert.match(negative.receipt.output.stderr, /88 !== 73/)
    await f.run('record_process_evidence', { evidence_id: negative.receipt.evidence_id, method: 'mutation', invariant: 'Only 73 approved entries' })
    await f.run('record_candidate', { candidate_id: good.frozen.candidate_id })
    const pass = { candidate_id: good.frozen.candidate_id, verdict: 'PASS', reviewer: 'independent', verification_evidence_ids: [good.receipt.evidence_id] }
    await assert.rejects(f.run('record_review', pass), /PROCESS_RECOVERY_PENDING/)
    await assert.rejects(f.run('complete_wu', { candidate_id: good.frozen.candidate_id }), /PROCESS_RECOVERY_PENDING/)
    await assert.rejects(f.run('record_process_review', { review_dispatch_id: 'invented' }), /handoff/)
    await f.review(`review${index}`, good.frozen.candidate_id, [negative.receipt.evidence_id])
    const before = await f.c.snapshot()
    const restarted = await createExecutionController({ dir: f.dir })
    assert.deepEqual(await restarted.snapshot(), before)
    await f.run('record_process_review', { review_dispatch_id: `review${index}` })
    await f.run('record_review', pass)
    await f.run('bind_pr', { candidate_id: good.frozen.candidate_id, repository: 'test/repo', pr_number: index + 1, head_sha: `head${index}`, base_sha: `base${index}`, base_branch: 'main' })
    await f.run('record_ci', { candidate_id: good.frozen.candidate_id, head_sha: `head${index}`, check_identity: 'verify', conclusion: 'SUCCESS' })
    let merged = false, mergeCalls = 0
    const adapter = {
      getCommitTree: async () => candidateGitTree(good.frozen),
      getPullRequest: async () => ({ state: merged ? 'closed' : 'open', merged, head_sha: `head${index}`, base_sha: `base${index}`, base_branch: 'main', merge_commit_sha: merged ? `merge${index}` : null }),
      getChecks: async () => [{ name: 'verify', conclusion: 'SUCCESS' }],
      merge: async () => { mergeCalls++; merged = true; return { merged: true, merge_commit_sha: `merge${index}` } },
    }
    await runMergeCandidate(f.root, { candidate_id: good.frozen.candidate_id, adapter, session_id: 'root' })
    await runMergeCandidate(f.root, { candidate_id: good.frozen.candidate_id, adapter, session_id: 'root' })
    assert.equal(mergeCalls, 1)
    await f.run('complete_wu', { candidate_id: good.frozen.candidate_id })
    assert.equal((await f.run('verify')).passed, true)
  }
  const { state, events } = await f.c.snapshot()
  assert.equal(events.filter(e => e.operation_type === 'PROCESS_POLICY_ADOPT').length, 1)
  assert.equal(Object.keys(state.process_recoveries).length, 2)
  assert.equal(state.wu.completed, true)
})

test('legacy authority recovery is scoped to the exact fingerprint; other product decisions accumulate', async t => {
  const f = await fixture(t)
  const b = await f.run('block', { class: 'BLOCKED_AUTHORITY', reason: 'legacy missed RED' })
  await f.adopt({ legacy_blocker_hashes: [b.blocker_fingerprint] })
  const before = (await f.c.snapshot()).state
  await f.start()
  const after = (await f.c.snapshot()).state
  for (const field of ['budget', 'wu', 'mandate', 'dispatches', 'candidates']) assert.deepEqual(after[field], before[field])
  assert.deepEqual(after.process_recoveries.WU1.original_blocker, before.blocker)
  await assert.rejects(f.run('block', { class: 'BLOCKED_AUTHORITY', reason: 'another technical failure' }), /actual owner decision/)
  await f.run('block', { class: 'BLOCKED_AUTHORITY', reason: 'extra SKU publication', authority_question: { domain: 'product', decision: 'Publish extras?', source_ref: 'scope73', why_not_delegated: 'Only73 approved' } })
  await assert.rejects(f.run('reserve', { dispatch_id: 'wrong', reserved_seconds: 10 }), /blocked/i)
  const synthetic = { wu: { wu_id: 'WU1' }, authority_resolutions: { WU1: [{ decision: 'retrospective' }, { decision: 'DEFERRED, active; extras excluded' }], WU2: [{ decision: 'unrelated' }] } }
  assert.deepEqual(applicableAuthority(synthetic).authority_resolutions, synthetic.authority_resolutions.WU1)
})

for (const cls of ['BLOCKED_AUTHORITY', 'BLOCKED_SECURITY', 'BLOCKED_PERMISSION', 'BLOCKED_SCOPE']) test(`process policy cannot erase unrelated ${cls}`, async t => {
  const f = await fixture(t)
  await f.run('block', { class: cls, reason: 'Unrelated unresolved decision' })
  await f.adopt()
  const before = await f.c.snapshot()
  await assert.rejects(f.start(), /cannot clear/)
  assert.deepEqual((await f.c.snapshot()).state, before.state); assert.deepEqual((await f.c.snapshot()).events, before.events)
})

test('policy rejects wrong mandate, unapproved record, modified source and never grants itself authority', async t => {
  const f = await fixture(t)
  await assert.rejects(f.start(), /policy required/)
  for (const [overrides, metadata] of [[{ mandate_id: 'other' }, {}], [{ execution_id: 'other' }, {}], [{ scope: 'all_projects' }, {}], [{ recoverable: ['TDD_ORDER', 'SECURITY'] }, {}], [{}, { status: 'PROPOSED' }]]) {
    const p = await f.policy(overrides, { artifact_id: `policy-${Object.entries(overrides).flat().join("-").replace(/[^A-Za-z0-9_-]/g, "_") || metadata.status || "test"}`, ...metadata })
    await assert.rejects(f.run('adopt_process_policy', { decision_artifact_id: p.record_key }))
  }
  const p = await f.policy()
  await appendFile(join(f.root, p.path), 'tampered')
  await assert.rejects(f.run('adopt_process_policy', { decision_artifact_id: p.record_key }), /INTEGRITY/)
})

test('negative evidence rejects PASS, timeout, setup failure, cancellation, tamper and traversal', async t => {
  const f = await fixture(t); await f.adopt(); await f.start()
  const { frozen, receipt } = await f.candidate(73)
  await assert.rejects(f.run('record_process_evidence', { evidence_id: receipt.evidence_id, method: 'mutation', invariant: 'count' }), /negative check/)
  for (const override of [{ timedOut: true }, { aborted: true }, { setup_results: [{ ok: false }] }, { exitCode: null }]) {
    const bad = createVerificationReceipt({ candidate_id: frozen.candidate_id, verification_contract_hash: receipt.verification_contract_hash, check_id: 'behavior', status: 'FAIL', exitCode: 1, ...override })
    await writeVerificationReceipt(join(f.root, '.harness/execution/verification-results'), bad)
    await assert.rejects(f.run('record_process_evidence', { evidence_id: bad.evidence_id, method: 'mutation', invariant: 'count' }), /negative check/)
  }
  await assert.rejects(f.run('record_process_evidence', { evidence_id: '../secret' }), /Invalid/)
  const negative = await f.candidate(88)
  await appendFile(join(f.root, '.harness/execution/verification-results', negative.receipt.evidence_id + '.json'), 'tamper')
  await assert.rejects(f.run('record_process_evidence', { evidence_id: negative.receipt.evidence_id }))
})

test('new obligations are typed, legacy prose preserved, RED cannot be replaced by GREEN', () => {
  for (const bad of [{}, 'TDD', [null], [{ kind: 'unknown', required: true }], [{ kind: 'tdd', required: false }]]) assert.throws(() => validateProcessObligations(bad))
  validateProcessObligations(['Legacy exact requirement', { kind: 'tdd', required: true }])
  const state = { ...initialState(), wu: { wu_id: 'WU', contract: { process_obligations: [{ kind: 'tdd', required: true }] } }, candidates: { green: { process_recorded_revision: 3 } } }
  assert.throws(() => assertProcessAcceptance(state, 'green'), /PROCESS_RED_REQUIRED/)
  state.process_red = { WU: { at_revision: 1, candidate_id: 'baseline' } }
  assert.doesNotThrow(() => assertProcessAcceptance(state, 'green'))
  state.process_red.WU.candidate_id = 'green'
  assert.throws(() => assertProcessAcceptance(state, 'green'))
})

test('generated checkpoint/read/candidate perturbations never authorize an unreviewed recovery', () => {
  for (let seed = 1; seed <= 200; seed++) {
    let random = seed
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0)
    let state = { ...initialState(), wu: { wu_id: 'WU' }, process_recoveries: { WU: { status: 'REPAIRING', evidence: [] } } }
    const budget = structuredClone(state.budget)
    for (let i = 0; i < 30; i++) {
      const action = next() % 3
      if (action === 0) state = applyEvent(state, { operation_type: 'CHECKPOINT', body: { note: `seed=${seed}:${i}` }, next_revision: state.revision + 1 })
      if (action === 1) { const hash = executionProgress(state); assert.equal(executionProgress(structuredClone(state)), hash) }
      if (action === 2) state.candidates[`candidate${i}`] = { wu_id: 'WU' }
      assert.throws(() => assertProcessAcceptance(state, `candidate${i}`), /PROCESS_RECOVERY_PENDING/, `seed=${seed}`)
      assert.equal(canStartMerge(state).allowed, false); assert.equal(canVerifyExternalMerge(state).allowed, false)
      assert.deepEqual(state.budget, budget)
    }
  }
})

test('changed evidence invalidates stale reviewer and candidate changes cannot reuse acceptance', async t => {
  const f = await fixture(t); await f.adopt(); await f.start()
  const negative = await f.candidate(88), good = await f.candidate(73)
  await f.run('record_process_evidence', { evidence_id: negative.receipt.evidence_id, method: 'mutation', invariant: 'count' })
  await f.run('record_candidate', { candidate_id: good.frozen.candidate_id })
  await f.review('old-review', good.frozen.candidate_id, [negative.receipt.evidence_id])
  const negative2 = await f.candidate(72)
  await f.run('record_process_evidence', { evidence_id: negative2.receipt.evidence_id, method: 'baseline', invariant: 'missing approved entry' })
  await assert.rejects(f.run('record_process_review', { review_dispatch_id: 'old-review' }), /evidence set/)
  await f.review('fresh-review', good.frozen.candidate_id, [negative.receipt.evidence_id, negative2.receipt.evidence_id])
  await f.run('record_process_review', { review_dispatch_id: 'fresh-review' })
  const { state } = await f.c.snapshot()
  assert.doesNotThrow(() => assertProcessAcceptance(state, good.frozen.candidate_id))
  assert.throws(() => assertProcessAcceptance(state, 'changed-candidate'), /PROCESS_RECOVERY_PENDING/)
  await assert.rejects(f.run('record_review', { candidate_id: good.frozen.candidate_id, verdict: 'PASS', verification_evidence_ids: [negative.receipt.evidence_id] }), /belongs to/)
})

test('recovery rejects live work and record_red cannot reconstruct pre-candidate evidence afterward', async t => {
  const f = await fixture(t); await f.adopt()
  await f.run('reserve', { dispatch_id: 'live', reserved_seconds: 10 })
  await assert.rejects(f.start(), /Settle existing/)
  await f.run('release', { dispatch_id: 'live', reason: 'Never launched' })
  const negative = await f.candidate(88)
  await f.run('record_red', { evidence_id: negative.receipt.evidence_id })
  const first = (await f.c.snapshot()).state.process_red.WU1
  assert.match(first.claim, /not proof/)
  const good = await f.candidate(73)
  await f.run('record_candidate', { candidate_id: good.frozen.candidate_id })
  const another = await f.candidate(72)
  await assert.rejects(f.run('record_red', { evidence_id: another.receipt.evidence_id }), /already recorded/)
})

test('simultaneous retries create one policy and one recovery transition', async t => {
  const f = await fixture(t)
  const p = await f.policy()
  const adopt = () => f.run('adopt_process_policy', { decision_artifact_id: p.record_key })
  const first = await Promise.allSettled([adopt(), adopt()])
  assert.ok(first.some(r => r.status === 'fulfilled'))
  await adopt() // supported retry after any optimistic revision conflict
  const starts = await Promise.allSettled([f.start(), f.start()])
  assert.ok(starts.some(r => r.status === 'fulfilled'))
  await f.start()
  const { events } = await f.c.snapshot()
  for (const type of ['PROCESS_POLICY_ADOPT', 'PROCESS_RECOVERY_START']) assert.equal(events.filter(e => e.operation_type === type).length, 1)
  assert.equal((await f.run('verify')).passed, true)
})

test('review attribution rejects another role, parent impersonation, changed evidence, missing receipt and wrong candidate', async t => {
  const f = await fixture(t); await f.adopt(); await f.start()
  const negative = await f.candidate(88), good = await f.candidate(73)
  await f.run('record_process_evidence', { evidence_id: negative.receipt.evidence_id, method: 'mutation', invariant: 'count' })
  await f.run('record_candidate', { candidate_id: good.frozen.candidate_id })
  await f.review('review', good.frozen.candidate_id, [negative.receipt.evidence_id])
  const { state } = await f.c.snapshot()
  const d = state.dispatches.review
  const attestation = JSON.parse(d.handoff.content.slice('process_review: '.length))
  const body = { ...attestation, review_dispatch_id: 'review', handoff_hash: d.handoff.content_hash }
  for (const variation of ['builder', 'parent', 'unsettled', 'changed-evidence', 'foreign-candidate', 'missing-evidence', 'changed-handoff', 'truncated']) {
    const altered = structuredClone(state), b = structuredClone(body)
    if (variation === 'builder') altered.dispatches.review.expected_agent = 'harness-builder'
    if (variation === 'parent') altered.dispatches.review.session_id = 'root'
    if (variation === 'unsettled') altered.dispatches.review.status = 'launched'
    if (variation === 'changed-evidence') altered.dispatches.review.process_evidence_hash = 'old'
    if (variation === 'foreign-candidate') b.candidate_id = 'different'
    if (variation === 'missing-evidence') b.evidence_ids = []
    if (variation === 'truncated') altered.dispatches.review.handoff.truncated = true
    if (variation === 'changed-handoff') b.handoff_hash = 'not-observed'
    assert.throws(() => applyEvent(altered, { operation_type: 'PROCESS_REVIEW', body: b }), undefined, variation)
  }
})

test('frozen pre-fix log retains byte-derived integrity, projection and supervisor progress', async () => {
  const { readFile } = await import('node:fs/promises')
  const { project } = await import('../../src/execution/state.js')
  const { validateLog } = await import('../../src/execution/event-log.js')
  const fixture = JSON.parse(await readFile(new URL('./legacy-process-fixture.json', import.meta.url), 'utf8'))
  validateLog(fixture.events)
  const state = project(fixture.events)
  assert.equal(stableHash(state), fixture.state_hash)
  assert.equal(executionProgress(state), fixture.progress_hash)
  assert.equal(state.process_policy, undefined)
  assert.equal(state.blocker.class, 'BLOCKED_AUTHORITY')
})

test('runtime worker receives all independent owner resolutions and the same scoped policy', async t => {
  const f = await fixture(t)
  for (const [i, resolution] of ['Retrospective validation authorized', '73 SKUs DEFERRED active; 15 extras excluded'].entries()) {
    const blocked = await f.run('block', { class: 'BLOCKED_AUTHORITY', reason: `Question ${i}` })
    const decision = await f.record({ artifact_type: 'decision', artifact_id: `resolution${i}`, content: 'authority_resolution: '+JSON.stringify({ execution_id: 'E', mandate_id: 'M', wu_id: 'WU1', blocked_at_revision: blocked.blocker.at_revision, resolution }) })
    await f.run('resolve_authority_blocker', { decision_artifact_id: decision.record_key })
  }
  await f.adopt()
  await f.run('reserve', { dispatch_id: 'builder', reserved_seconds: 10 })
  await f.run('prepare_launch', { dispatch_id: 'builder', launch_agent: 'harness-builder' })
  await f.commit('DISPATCH_LAUNCH_CLAIM', { dispatch_id: 'builder', call_id: 'call' })
  await f.commit('DISPATCH_LAUNCH', { dispatch_id: 'builder', session_id: 'child' })
  const { createWorkerBudgetGuard } = await import('../../src/execution/worker-budget.js')
  const guard = createWorkerBudgetGuard({ session: { get: async () => ({ id: 'child', parentID: 'root', agent: 'harness-builder' }) } }, f.root, {})
  t.after(() => guard.dispose())
  const context = await guard.inspect('child', 'harness-builder')
  assert.equal(context.authority_resolutions.length, 2)
  assert.match(context.authority_resolutions[0].resolution, /Retrospective/)
  assert.match(context.authority_resolutions[1].resolution, /73 SKUs/)
  assert.equal(context.process_policy.policy.scope, 'remaining_epic')
})

test('public delegated additive correction reads proposed artifact, retains original scope and replays', async t => {
  const f = await fixture(t); await f.adopt()
  const old = (await f.c.snapshot()).state.wu.contract
  const typed = { active_seconds: old.active_seconds, process_obligations: old.process_obligations, verification_contract: { ...old.verification_contract, commands: [...old.verification_contract.commands, { id: 'extra', program: 'node', args: ['--version'] }] } }
  const proposal = await f.record({ artifact_type: 'work-unit', artifact_id: 'WU1-extra', title: 'WU1', status: 'PROPOSED', parent_refs: ['epic'], content: old.source_content.replace(/^execution_contract: .*$/m, 'execution_contract: '+JSON.stringify(typed)) })
  const args = { wu_artifact_id: proposal.record_key, expected_contract_hash: old.contract_hash, reason: 'Add discovered regression' }
  const rejected = await f.record({ artifact_type: 'work-unit', artifact_id: 'WU1-rejected', status: 'REJECTED', parent_refs: ['epic'], content: old.source_content })
  await assert.rejects(f.run('correct_verification_contract', { ...args, wu_artifact_id: rejected.record_key }), /PROPOSED WU source/)
  await f.run('correct_verification_contract', args)
  assert.equal((await f.run('correct_verification_contract', args)).commit_status, 'replayed')
  const contract = (await f.c.snapshot()).state.wu.contract
  assert.equal(contract.source_content, old.source_content)
  assert.equal(contract.correction_source.source_authority, 'DELEGATED_TECHNICAL')
  assert.equal(contract.verification_contract.commands.length, 2)
  assert.equal((await f.run('verify')).passed, true)
})
