import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { createExecutionSupervisor } from "../../src/execution/supervisor.js"

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "supervisor-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const c = await createExecutionController({ dir: join(root, ".harness/execution/controller/E") })
  const commit = async (type, body) => {
    const lease = await c.acquire("ses_root"), { state } = await c.snapshot()
    return c.commit({ operation_id: `test:${state.revision}`, operation_type: type, body },
      { holder_session_id: "ses_root", expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  await commit("MANDATE_APPROVE", { execution_id: "E", mandate_id: "M", total_seconds: 100, max_wus: 2,
    authority_kind: "OWNER_APPROVED_EPIC", source_artifact_id: "epic", source_record_key: "r", source_hash: "h" })
  await commit("WU_ACTIVATE", { wu_id: "WU1", mandate_id: "M" })
  const prompts = new Map()
  let ambiguous = false
  const ctx = { session: { get: async () => ({ id: "ses_root", agent: "harness-orchestrator", outcome: "succeeded" }),
    prompt: async input => { prompts.set(input.id, input); if (ambiguous) { ambiguous = false; throw new Error("lost response") } return { id: input.id } } } }
  const make = () => createExecutionSupervisor(ctx, root)
  const s = make()
  await s.bind("E", "ses_root")
  return { c, root, commit, prompts, s, make, ctx, loseNextResponse: () => { ambiguous = true } }
}

test("supervisor wakes only the bound root, once per durable progress", async t => {
  const f = await fixture(t)
  assert.equal(await f.s.tick("E"), true)
  assert.equal(await f.s.tick("E"), false)
  await f.commit("CHECKPOINT", { note: "prose is not progress" })
  assert.equal(await f.s.tick("E"), false)
  await f.commit("DISPATCH_RESERVE", { dispatch_id: "d", reserved_seconds: 10 })
  assert.equal(await f.s.tick("E"), true)
  assert.equal(f.prompts.size, 2)
  assert.ok([...f.prompts.values()].every(p => p.sessionID === "ses_root"))
})

test("supervisor restart retries the same durable prompt identity after an ambiguous response", async t => {
  const f = await fixture(t)
  f.loseNextResponse()
  await assert.rejects(f.s.tick("E"), /lost response/)
  const first = (await f.c.snapshot()).state.supervisor.intent.intent_id
  assert.equal(await f.make().tick("E"), true)
  assert.equal(f.prompts.size, 1)
  assert.equal((await f.c.snapshot()).state.supervisor.intent.intent_id, first)
})

test("supervisor never continues through a blocker or user interruption", async t => {
  const f = await fixture(t)
  f.ctx.session.get = async () => ({ id: "ses_root", agent: "harness-orchestrator", outcome: "interrupted" })
  assert.equal(await f.s.tick("E"), false)
  f.ctx.session.get = async () => ({ id: "ses_root", agent: "harness-orchestrator", outcome: "succeeded" })
  await f.commit("BLOCK", { class: "BLOCKED_AUTHORITY", reason: "new decision required" })
  assert.equal(await f.s.tick("E"), false)
  assert.equal(f.prompts.size, 0)
})

test("supervisor restores durable wait timer after restart and wakes only when due", async t => {
  const f = await fixture(t)
  const start = new Date(Date.now() - 1000).toISOString()
  const due = new Date(Date.now() + 100000).toISOString()
  await f.commit("EXTERNAL_WAIT", { wait_id: "w", operation: "merge:candidate", kind: "CI_PENDING", reason: "running",
    attempt: 1, started_at: start, next_retry_at: due, deadline_at: new Date(Date.now() + 200000).toISOString() })
  const timers = []
  const restored = createExecutionSupervisor(f.ctx, f.root, { enabled: true,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer }, cancel: () => {} })
  t.after(() => restored.dispose())
  await restored.resume()
  assert.equal(f.prompts.size, 0)
  assert.equal(timers.length, 1)
  assert.ok(timers[0].delay > 0)
})

test("a due external wait wakes once and never duplicates an admitted continuation", async t => {
  const f = await fixture(t)
  await f.commit("EXTERNAL_WAIT", { wait_id: "due-wait", operation: "merge:candidate", kind: "CI_PENDING", reason: "running",
    attempt: 1, started_at: new Date(Date.now() - 2000).toISOString(), next_retry_at: new Date(Date.now() - 1000).toISOString(), deadline_at: new Date(Date.now() + 60000).toISOString() })
  await f.s.resume()
  assert.equal(f.prompts.size, 1)
  assert.match([...f.prompts.values()][0].text, /external wait is due/)
  await f.make().resume()
  assert.equal(f.prompts.size, 1)
  assert.equal((await f.c.snapshot()).state.external_wait.due, true)
})


test("explicit supervisor opt-out never binds or resumes an execution", async t => {
  const f = await fixture(t)
  const disabled = createExecutionSupervisor(f.ctx, f.root, { enabled: false })
  t.after(() => disabled.dispose())
  const before = await f.c.snapshot()
  await disabled.bind("E", "ses_root")
  await disabled.resume()
  assert.equal(await disabled.tick("E"), false)
  assert.deepEqual(await f.c.snapshot(), before)
  assert.equal(f.prompts.size, 0)
})
