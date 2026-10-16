import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { createExecutionSupervisor } from "../../src/execution/supervisor.js"

async function fixture(t, planning = false) {
  const root = await mkdtemp(join(tmpdir(), "supervisor-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const c = await createExecutionController({ dir: join(root, ".harness/execution/controller/E") })
  const commit = async (type, body) => {
    const lease = await c.acquire("ses_root"), { state } = await c.snapshot()
    return c.commit({ operation_id: `test:${state.revision}`, operation_type: type, body },
      { holder_session_id: "ses_root", expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  await commit("MANDATE_APPROVE", { execution_id: "E", mandate_id: "M", total_seconds: 100, max_wus: 2,
    ...(planning ? { time_policy: "WU_PLANNING_ESTIMATES" } : {}),
    wu_sequence: ["WU1", "WU2"],
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


test("supervisor resumes after WU estimate overrun while Epic budget remains", async t => {
  const f = await fixture(t, true)
  t.after(() => f.s.dispose())
  await f.commit("WU_CONTRACT_BIND", { contract: { wu_id: "WU1", active_seconds: 10 } })
  await f.commit("PHASE_START", { phase: "ACTIVE", started_at: 0 })
  await f.commit("PHASE_END", { ended_at: 12 })
  assert.equal(await f.s.tick("E"), true)
  assert.equal(f.prompts.size, 1)
})

test('expired external wait schedules one observational continuation, survives restart and respects cancellation', async t => {
  const f = await fixture(t)
  const at = new Date(Date.now() - 1000).toISOString()
  await f.commit('EXTERNAL_WAIT', { wait_id: 'expired', operation: 'harness_merge_candidate:candidate', kind: 'CI_PENDING', reason: 'running', attempt: 1, started_at: at, next_retry_at: at, deadline_at: at })
  await f.commit('EXTERNAL_WAIT_END', { wait_id: 'expired', outcome: 'EXPIRED' })
  f.ctx.session.get = async () => ({ id: 'ses_root', agent: 'harness-orchestrator', outcome: 'interrupted' })
  assert.equal(await f.s.tick('E'), false)
  f.ctx.session.get = async () => ({ id: 'ses_root', agent: 'harness-orchestrator', outcome: 'succeeded' })
  assert.equal(await f.s.tick('E'), true)
  assert.match([...f.prompts.values()][0].text, /Observe the remote condition for expired wait/)
  assert.equal(await f.make().tick('E'), false)
  assert.equal((await f.c.snapshot()).state.blocker.class, 'BLOCKED_EXTERNAL_FACT')
  assert.equal(f.prompts.size, 1)
})

test("tooling blocker receives one non-billable diagnostic wake, then ordinary continuation only after verified clearance", async t => {
  const f = await fixture(t)
  await f.commit("BLOCK", { class: "BLOCKED_TOOLING", reason: "historical COMPLETE replay failed" })
  const before = (await f.c.snapshot()).state
  assert.equal(await f.s.tick("E"), true)
  const diagnostic = [...f.prompts.values()][0]
  assert.match(diagnostic.text, /One-time read-only tooling diagnosis/)
  assert.match(diagnostic.text, /Never start a new WU, reserve or launch a dispatch/)
  assert.equal(await f.s.tick("E"), false)
  await f.commit("CHECKPOINT", { note: "diagnosis only, not a new recovery" })
  assert.equal(await f.s.tick("E"), false)
  const blocked = (await f.c.snapshot()).state
  assert.equal(blocked.blocker.class, "BLOCKED_TOOLING")
  assert.equal(blocked.wu.completed, false)
  assert.equal(blocked.budget.reserved_seconds, before.budget.reserved_seconds)
  assert.equal(blocked.budget.used_seconds, before.budget.used_seconds)
  assert.deepEqual(blocked.dispatches, before.dispatches)
  await f.commit("CLEAR_BLOCKER", { blocker_class: "BLOCKED_TOOLING",
    blocked_at_revision: blocked.blocker.at_revision, resolution: "Exact upstream repair verified in updated runtime" })
  assert.equal(await f.s.tick("E"), true)
  const prompts = [...f.prompts.values()]
  assert.equal(prompts.length, 2)
  assert.match(prompts[1].text, /Continue execution E from durable status/)
})

test("authority and scope blockers never receive autonomous diagnostic wake", async t => {
  for (const cls of ["BLOCKED_AUTHORITY", "BLOCKED_SCOPE", "BLOCKED_SECURITY"]) {
    const f = await fixture(t)
    await f.commit("BLOCK", { class: cls, reason: "human decision required" })
    assert.equal(await f.s.tick("E"), false)
    assert.equal(f.prompts.size, 0)
  }
})


test("completed predecessor technical-contract blocker wakes once for governed JIT without bypassing authority", async t => {
  const f = await fixture(t, true)
  await f.commit("FREEZE_CANDIDATE", { candidate_id: "cand-jit-before", wu_id: "WU1",
    manifest_hash: "m", tree_hash: "t" })
  await f.commit("RECORD_REVIEW", { candidate_id: "cand-jit-before", verdict: "PASS",
    candidate_hashes: { manifest_hash: "m", tree_hash: "t" },
    verification_evidence_ids: ["test-receipt"], verified_check_ids: [], verification_contract_hash: null })
  await f.commit("WU_COMPLETE", { candidate_id: "cand-jit-before" })
  await f.commit("BLOCK", { class: "BLOCKED_AUTHORITY",
    reason: "next WU has no executable approved contract with finite active_seconds" })
  const before = (await f.c.snapshot()).state
  assert.equal(await f.s.tick("E"), true)
  assert.match([...f.prompts.values()][0].text, /derive_and_stage_next_wu_contract/)
  assert.equal(await f.s.tick("E"), false)
  const after = (await f.c.snapshot()).state
  assert.equal(after.blocker.class, "BLOCKED_AUTHORITY")
  assert.equal(after.budget.used_seconds, before.budget.used_seconds)
  assert.equal(after.wu.completed, true)
  assert.equal(after.activated_wu_ids.length, 1)
})
