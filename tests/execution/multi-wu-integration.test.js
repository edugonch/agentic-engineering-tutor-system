import { freezeCandidate } from '../../src/execution/candidate.js'
import { createCandidateRegistry } from '../../src/execution/candidate-registry.js'
import { candidateGitTree } from '../../src/execution/git-tree.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionController } from '../../src/execution/execution.js'
import { runExecutionController } from '../../src/execution/controller-tool.js'
import { runMergeCandidate, runVerifyExternalMerge } from '../../src/execution/merge.js'

async function fixture(fn, policy = 'governed_auto') {
  const root = await mkdtemp(join(tmpdir(), 'harness-multi-wu-'))
  const dir = join(root, '.harness/execution/controller/E1')
  const controller = await createExecutionController({ dir })
  const commit = async (operation_type, body, operation_id) => {
    const lease = await controller.acquire('audit')
    const { state } = await controller.snapshot()
    return controller.commit({ operation_id: operation_id ?? `seed:${state.revision}`, operation_type, body: body?.candidate_id ? { ...body, candidate_id: ids[body.candidate_id] ?? body.candidate_id } : body }, {
      holder_session_id: 'audit', expected_revision: state.revision, lease_fencing_token: lease.fencing_token,
    })
  }
  const ids = {}
  const registry = createCandidateRegistry({ dir: join(root, '.harness/execution') })
  const tool = input => runExecutionController(root, { execution_id: 'E1', session_id: 'audit', ...input, ...(input.candidate_id ? { candidate_id: ids[input.candidate_id] ?? input.candidate_id } : {}) })
  const prepare = async n => {
    await commit('WU_ACTIVATE', { wu_id: `WU${n}`, mandate_id: 'M1' })
    await candidate(n)
  }
  const candidate = async n => {
    const { state } = await controller.snapshot()
    const frozen = await freezeCandidate(root, { base: { kind: 'snapshot', files: [{ path: 'n.txt', type: 'file', mode: '100644', content: Buffer.from(String(n)).toString('base64'), sha256: (await import('node:crypto')).createHash('sha256').update(String(n)).digest('hex') }] } })
    await registry.store(frozen)
    ids[`c${n}`] = frozen.candidate_id
    await commit('FREEZE_CANDIDATE', { candidate_id: frozen.candidate_id, wu_id: state.wu.wu_id, manifest_hash: `m${n}`, tree_hash: `t${n}` })
    await commit('RECORD_REVIEW', { candidate_id: `c${n}`, candidate_hashes: { manifest_hash: `m${n}`, tree_hash: `t${n}` }, verdict: 'PASS', verification_evidence_ids: [`e${n}`] })
  }
  const bind = n => tool({ action: 'bind_pr', candidate_id: `c${n}`, repository: 'o/r', pr_number: 160 + n, head_sha: `h${n}`, base_branch: 'main', base_sha: `b${n}` })
  const ci = (n, conclusion = 'SUCCESS', evidence_ref = 'run1') => tool({ action: 'record_ci', candidate_id: `c${n}`, head_sha: `h${n}`, check_identity: 'verify', conclusion, evidence_ref })
  const calls = []
  const merged = new Set()
  const adapter = {
    getCommitTree: async ({ head_sha }) => candidateGitTree(await registry.load(ids[`c${head_sha.slice(1)}`])),
    getPullRequest: async ({ pr_number }) => { const n = pr_number - 160; return { state: merged.has(n) ? 'closed' : 'open', merged: merged.has(n), head_sha: `h${n}`, base_sha: `b${n}`, base_branch: 'main', merge_commit_sha: merged.has(n) ? `merge${n}` : null } },
    getChecks: async () => [{ name: 'verify', conclusion: 'SUCCESS' }],
    merge: async ({ pr_number }) => { const n = pr_number - 160; calls.push(n); merged.add(n); return { merged: true, merge_commit_sha: `merge${n}` } },
  }
  const merge = n => (policy === 'human' ? runVerifyExternalMerge : runMergeCandidate)(root, { candidate_id: ids[`c${n}`], adapter, session_id: 'audit' })
  try {
    await commit('MANDATE_APPROVE', { execution_id: 'E1', mandate_id: 'M1', max_wus: 4, total_seconds: 100, merge_policy: policy, required_ci_checks: ['verify'] })
    await fn({ ids, root, dir, controller, commit, tool, prepare, candidate, bind, ci, merge, calls, merged, adapter })
  } finally { await rm(root, { recursive: true, force: true }) }
}

for (const policy of ['governed_auto', 'human']) test(`two consecutive WUs: ${policy}, independent merges and idempotent retries`, async () => {
  await fixture(async f => {
    for (const n of [1, 2]) {
      await f.prepare(n); await f.bind(n); await f.ci(n)
      if (policy === 'human') f.merged.add(n)
      await f.merge(n)
      assert.equal((await f.merge(n)).status, 'already_verified')
      await f.tool({ action: 'complete_wu', candidate_id: `c${n}` })
    }
    const { state } = await f.controller.snapshot()
    assert.equal(state.wu.completed, true)
    assert.equal(state.merges[f.ids.c1].status, 'VERIFIED')
    assert.equal(state.merges[f.ids.c2].status, 'VERIFIED')
    assert.equal(state.pr_bindings[f.ids.c1].pr_number, 161)
    assert.equal(state.pr_bindings[f.ids.c2].pr_number, 162)
    assert.deepEqual(f.calls, policy === 'human' ? [] : [1, 2])
  }, policy)
})

test('legacy verified merge and already activated successor recover without rewriting events', async () => {
  await fixture(async f => {
    await f.prepare(1)
    await f.commit('BIND_PR', { candidate_id: 'c1', repository: 'o/r', pr_number: 161, head_sha: 'h1', base_branch: 'main', base_sha: 'b1' }, 'E1:bind-pr:161')
    await f.commit('RECORD_CI', { candidate_id: 'c1', head_sha: 'h1', check_identity: 'verify', conclusion: 'SUCCESS', evidence_ref: 'run1' }, 'E1:record-ci:verify')
    await f.commit('BLOCK', { class: 'BLOCKED_TOOLING', reason: 'legacy blocker' }, 'E1:block')
    await f.tool({ action: 'clear_blocker', resolution: 'legacy resolved' })
    await f.commit('MERGE_START', {}, 'E1:merge-start')
    await f.commit('MERGE_RECORD', { merge_commit_sha: 'merge1', merged_head_sha: 'h1' }, 'E1:merge-record:merge1')
    await f.commit('MERGE_VERIFY', {}, 'E1:merge-verify')
    await f.tool({ action: 'complete_wu', candidate_id: 'c1' })
    await f.prepare(2)
    const before = await readFile(join(f.dir, 'events.ndjson'), 'utf8')
    await f.bind(2); await f.ci(2); await f.merge(2)
    await f.tool({ action: 'block', class: 'BLOCKED_TOOLING', reason: 'new blocker' })
    await f.tool({ action: 'clear_blocker', resolution: 'new resolved' })
    await f.tool({ action: 'complete_wu', candidate_id: 'c2' })
    assert.ok((await readFile(join(f.dir, 'events.ndjson'), 'utf8')).startsWith(before))
    assert.deepEqual(f.calls, [2])
  })
})

test('CI observations can change and each candidate reuses the same check name', async () => {
  await fixture(async f => {
    await f.prepare(1)
    await f.ci(1, 'PENDING')
    await f.ci(1)
    assert.equal((await f.ci(1)).commit_status, 'replayed')
    await f.ci(1, 'FAILURE', 'run2')
    await f.ci(1, 'SUCCESS', 'run3')
    assert.equal((await f.controller.snapshot()).state.ci_evidence[f.ids.c1].verify.conclusion, 'SUCCESS')
    await f.candidate(2); await f.ci(2)
  })
})

test('successive blocker episodes, including identical reasons, do not replay historical blocks', async () => {
  await fixture(async f => {
    for (const reason of ['first', 'second', 'second']) {
      const input = { action: 'block', class: 'BLOCKED_TOOLING', reason }
      assert.equal((await f.tool(input)).commit_status, 'committed')
      assert.equal((await f.tool(input)).commit_status, 'replayed')
      await f.tool({ action: 'clear_blocker', resolution: 'resolved' })
    }
  })
})

test('an unfinished merge cannot be replaced by a newly reviewed candidate', async () => {
  await fixture(async f => {
    await f.prepare(1); await f.bind(1); await f.ci(1)
    await f.commit('MERGE_START', {})
    await f.candidate(2)
    await assert.rejects(f.bind(2), /already bound|in progress/)
  })
})

test('second WU recovers a crash after remote merge and durable record without merging twice', async () => {
  await fixture(async f => {
    await f.prepare(1); await f.bind(1); await f.ci(1); await f.merge(1)
    await f.tool({ action: 'complete_wu', candidate_id: 'c1' })
    await f.prepare(2); await f.bind(2); await f.ci(2)
    const original = f.adapter.getPullRequest
    let reads = 0
    f.adapter.getPullRequest = async input => {
      reads++
      if (f.merged.has(2)) throw new Error('simulated connection loss after merge record')
      return original(input)
    }
    await assert.rejects(f.merge(2), /simulated connection loss/)
    assert.equal((await f.controller.snapshot()).state.merge.status, 'RECORDED')
    f.adapter.getPullRequest = original
    assert.equal((await f.merge(2)).status, 'recovered_existing_merge')
    await f.tool({ action: 'complete_wu', candidate_id: 'c2' })
    assert.deepEqual(f.calls, [1, 2])
  })
})

test('new candidate cannot reuse predecessor CI or close against predecessor merge', async () => {
  await fixture(async f => {
    await f.prepare(1); await f.bind(1); await f.ci(1); await f.merge(1)
    await f.tool({ action: 'complete_wu', candidate_id: 'c1' })
    await f.prepare(2)
    await assert.rejects(f.tool({ action: 'complete_wu', candidate_id: 'c2' }), /does not match/)
    await f.bind(2)
    f.adapter.getChecks = async ({ head_sha }) => {
      assert.equal(head_sha, 'h2') // predecessor CI cannot satisfy the new head
      return [{ name: 'verify', conclusion: 'PENDING', pending: true }]
    }
    await assert.rejects(f.merge(2), /CI verify.*PENDING/)
    assert.deepEqual(f.calls, [1])
    assert.equal((await f.controller.snapshot()).state.merge, null)
  })
})

test('replacement requires fresh PASS review and cannot change an existing candidate binding', async () => {
  await fixture(async f => {
    await f.prepare(1); await f.bind(1)
    await f.commit('FREEZE_CANDIDATE', { candidate_id: 'c2', wu_id: 'WU1', manifest_hash: 'm2', tree_hash: 't2' })
    await assert.rejects(f.bind(2), /already bound/)
    await f.commit('RECORD_REVIEW', { candidate_id: 'c2', candidate_hashes: { manifest_hash: 'm2', tree_hash: 't2' }, verdict: 'PASS', verification_evidence_ids: ['e2'] })
    await f.bind(2)
    await assert.rejects(f.tool({ action: 'bind_pr', candidate_id: 'c2', repository: 'o/r', pr_number: 162, head_sha: 'changed', base_branch: 'main', base_sha: 'b2' }), /conflict|already bound/)
    assert.equal((await f.controller.snapshot()).state.pr_bindings[f.ids.c1].head_sha, 'h1')
  })
})

test('new blocker identities cannot replace or downgrade an active terminal blocker', async () => {
  await fixture(async f => {
    await f.tool({ action: 'block', class: 'BLOCKED_SECURITY', reason: 'security stop' })
    await assert.rejects(f.tool({ action: 'block', class: 'BLOCKED_TOOLING', reason: 'recoverable' }), /active blocker cannot be replaced/)
    assert.equal((await f.controller.snapshot()).state.blocker.class, 'BLOCKED_SECURITY')
  })
})
