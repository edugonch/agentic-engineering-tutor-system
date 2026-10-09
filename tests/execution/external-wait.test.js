import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { runWithExternalWait, ExternalWaitError } from "../../src/execution/external-wait.js"
import { createTurnGuard } from "../../src/turn-guard.js"

async function fixture(t, required_ci_checks = []) {
  const root = await mkdtemp(join(tmpdir(), "external-wait-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const c = await createExecutionController({ dir: root })
  const commit = async (type, body) => {
    const lease = await c.acquire("root"), { state } = await c.snapshot()
    return c.commit({ operation_type: type, operation_id: `test-${state.revision}`, body },
      { holder_session_id: "root", expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  await commit("MANDATE_APPROVE", { mandate_id: "M", total_seconds: 100, max_wus: 1, required_ci_checks })
  await commit("WU_ACTIVATE", { wu_id: "WU1", mandate_id: "M" })
  return { c, root, commit }
}

test("external wait backoff survives reconstruction and success settles the same wait", async t => {
  const { c, root } = await fixture(t)
  let clock = Date.now(), calls = 0
  const input = { controller: c, session_id: "root", operation: "merge:candidate", now: () => clock,
    run: async () => { calls++; throw new ExternalWaitError("CI_PENDING", "CI still running") } }
  const first = await runWithExternalWait(input)
  assert.equal(first.status, "WAITING_EXTERNAL")
  const restarted = await createExecutionController({ dir: root })
  assert.deepEqual(await runWithExternalWait({ ...input, controller: restarted }), first)
  assert.equal(calls, 1)
  clock = Date.parse(first.next_retry_at)
  const second = await runWithExternalWait({ ...input, controller: restarted })
  assert.equal(calls, 2)
  assert.ok(Date.parse(second.next_retry_at) - clock > Date.parse(first.next_retry_at) - Date.parse(first.started_at))
  clock = Date.parse(second.next_retry_at)
  assert.equal((await runWithExternalWait({ ...input, run: async () => ({ status: "merged" }) })).status, "merged")
  const state = (await c.snapshot()).state
  assert.equal(state.external_wait, null)
  assert.equal(state.external_wait_history.at(-1).outcome, "RESOLVED")
  assert.equal(state.budget.used_seconds, 0)
})

test("permission failures never become waits and a new blocker prevents automatic retry", async t => {
  const { c, commit } = await fixture(t)
  const input = { controller: c, session_id: "root", operation: "merge:candidate", run: async () => { throw new Error("permission denied") } }
  await assert.rejects(runWithExternalWait(input), /permission denied/)
  assert.equal((await c.snapshot()).state.external_wait, undefined)
  await runWithExternalWait({ ...input, run: async () => { throw new ExternalWaitError("REMOTE_TRANSIENT", "temporary") } })
  await commit("BLOCK", { class: "BLOCKED_SECURITY", reason: "new finding" })
  let called = false
  await assert.rejects(runWithExternalWait({ ...input, now: () => Date.now() + 100000, run: async () => { called = true } }), /BLOCKED_SECURITY/)
  assert.equal(called, false)
})

test("expired external wait records one diagnosable blocker without repeated requests", async t => {
  const { c } = await fixture(t)
  let now = Date.now(), calls = 0
  const args = { controller: c, session_id: "root", operation: "merge:candidate", now: () => now, waitLimitMs: 1000,
    run: async () => { calls++; throw new ExternalWaitError("REMOTE_TRANSIENT", "unavailable") } }
  await runWithExternalWait(args)
  now += 1001
  const result = await runWithExternalWait(args)
  assert.equal(result.status, "BLOCKED_EXTERNAL_FACT")
  assert.equal(calls, 1)
  assert.equal((await c.snapshot()).state.blocker.class, "BLOCKED_EXTERNAL_FACT")
})

test("scheduled transient retries do not trigger the repeated mutation breaker", async t => {
  const { c } = await fixture(t), guard = createTurnGuard()
  let now = Date.now()
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await runWithExternalWait({ controller: c, session_id: "root", operation: "merge:candidate", now: () => now,
      run: () => guard.runHarness("root", "harness_merge_candidate", { candidate_id: "candidate" },
        async () => { throw new ExternalWaitError("CI_PENDING", "running") }, async () => ({ ci: "unchanged" })) })
    assert.equal(result.status, "WAITING_EXTERNAL")
    now = Date.parse(result.next_retry_at)
  }
})

// A read-only boundary is essential: a deadline never licenses a merge.
for (const conclusion of ['SUCCESS', 'FAILURE', 'PENDING']) test(`deadline observes current exact-head CI ${conclusion} before deciding`, async t => {
  const { c, commit } = await fixture(t, ['verify'])
  // A minimal recorded candidate/PR fixture; the run callback below stands for
  // the ordinary governed gate and deliberately rejects failure.
  await commit('FREEZE_CANDIDATE', { candidate_id: 'candidate', wu_id: 'WU1', manifest_hash: 'm', tree_hash: 't' })
  await commit('BIND_PR', { candidate_id: 'candidate', repository: 'test/repo', pr_number: 1, head_sha: 'head', base_sha: 'base', base_branch: 'main' })
  let clock = Date.now(), mutations = 0, reads = 0
  const operation = 'harness_merge_candidate:candidate'
  const base = { controller: c, session_id: 'root', operation, now: () => clock, waitLimitMs: 1000 }
  await runWithExternalWait({ ...base, run: async () => { throw new ExternalWaitError('CI_PENDING', 'running') } })
  clock += 1001
  const observe = async () => { reads++; return { binding: (await c.snapshot()).state.pr_binding, pr: { state: 'open', merged: false, head_sha: 'head', base_sha: 'base' }, checks: [{ name: 'verify', conclusion, pending: conclusion === 'PENDING' }] } }
  const input = { ...base, observe,
    run: async () => { if (conclusion !== 'SUCCESS') throw new Error('CI failure; no merge'); mutations++; return { status: 'merged' } } }
  if (conclusion === 'FAILURE') await assert.rejects(runWithExternalWait(input), /CI failure/)
  else assert.equal((await runWithExternalWait(input)).status, conclusion === 'SUCCESS' ? 'merged' : 'BLOCKED_EXTERNAL_FACT')
  assert.equal(reads, 1); assert.equal(mutations, conclusion === 'SUCCESS' ? 1 : 0)
  assert.equal((await c.snapshot()).state.external_wait, null)
})

test('expired timeout recovery is read-only until terminal observation and never clears another blocker', async t => {
  const { c, commit } = await fixture(t)
  await commit('FREEZE_CANDIDATE', { candidate_id: 'candidate', wu_id: 'WU1', manifest_hash: 'm', tree_hash: 't' })
  await commit('BIND_PR', { candidate_id: 'candidate', repository: 'test/repo', pr_number: 1, head_sha: 'head', base_sha: 'base', base_branch: 'main' })
  let clock = Date.now(), mutations = 0
  const args = { controller: c, session_id: 'root', operation: 'harness_merge_candidate:candidate', now: () => clock, waitLimitMs: 1 }
  await runWithExternalWait({ ...args, run: async () => { throw new ExternalWaitError('CI_PENDING', 'running') } })
  clock++
  await runWithExternalWait({ ...args, run: async () => assert.fail('no premature mutation') })
  const before = await c.snapshot()
  await assert.rejects(runWithExternalWait({ ...args, observe: async () => { throw new Error('permission denied') }, run: async () => mutations++ }), /permission denied/)
  assert.deepEqual(await c.snapshot(), before)
  const observation = { binding: before.state.pr_binding, pr: { state: 'open', head_sha: 'head', base_sha: 'base' }, checks: [] }
  const result = await runWithExternalWait({ ...args, observe: async () => observation, run: async () => { mutations++; return { status: 'merged' } } })
  assert.equal(result.status, 'merged'); assert.equal(mutations, 1)
  const after = await c.snapshot()
  assert.equal(after.state.blocker, null)
  assert.equal(after.events.filter(e => e.operation_type === 'EXTERNAL_OBSERVATION_RECOVER').length, 1)
  assert.deepEqual(after.events.slice(0, before.events.length), before.events)
  await commit('BLOCK', { class: 'BLOCKED_SECURITY', reason: 'new issue' })
  await assert.rejects(runWithExternalWait({ ...args, observe: async () => assert.fail('do not read for security bypass'), run: async () => mutations++ }), /BLOCKED_SECURITY/)
})
