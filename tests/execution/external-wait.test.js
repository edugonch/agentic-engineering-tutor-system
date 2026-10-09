import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { runWithExternalWait, ExternalWaitError } from "../../src/execution/external-wait.js"
import { createTurnGuard } from "../../src/turn-guard.js"

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "external-wait-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const c = await createExecutionController({ dir: root })
  const commit = async (type, body) => {
    const lease = await c.acquire("root"), { state } = await c.snapshot()
    return c.commit({ operation_type: type, operation_id: `test-${state.revision}`, body },
      { holder_session_id: "root", expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  await commit("MANDATE_APPROVE", { mandate_id: "M", total_seconds: 100, max_wus: 1 })
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
