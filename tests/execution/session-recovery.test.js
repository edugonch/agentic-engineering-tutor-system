import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionRecovery } from "../../src/execution/session-recovery.js"
import { runExecutionController, claimDispatchLaunch } from "../../src/execution/controller-tool.js"
import { createExecutionController } from "../../src/execution/execution.js"

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harness-recovery-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = { execution_id: "E1", dispatch_id: "d1", session_id: "ses_parent" }
  const run = (action, extra = {}) => runExecutionController(root, { ...input, action, ...extra })
  await run("init", { total_seconds: 100 })
  await run("reserve", { reserved_seconds: 20 })
  await run("prepare_launch", { launch_agent: "harness-builder" })
  await claimDispatchLaunch(root, { ...input, call_id: "call_exact" })
  const controller = await createExecutionController({ dir: join(root, ".harness", "execution", "controller", "E1") })
  const child = { id: "ses_child", parentID: "ses_parent", agent: "harness-builder" }
  const messages = [{ id: "msg_exact", type: "assistant", content: [{ type: "tool", id: "call_exact", name: "subagent",
    state: { status: "running", input: { agent: "harness-builder" }, metadata: { sessionID: "ses_child", status: "running" } } }] }]
  let reads = 0
  const ctx = { session: {
    get: async ({ sessionID }) => sessionID === "ses_parent" ? { id: sessionID, agent: "harness-orchestrator" } : child,
    context: async ({ sessionID }) => { assert.equal(sessionID, "ses_parent"); reads++; return messages },
  } }
  return { root, input, run, controller, child, messages, ctx, reads: () => reads, recovery: createSessionRecovery(ctx, root) }
}

test("restart recovers exact running progress identity; never finishes or consumes reservation", async t => {
  const f = await fixture(t)
  // Distractor identity in prose is not evidence.
  f.messages.unshift({ type: "user", content: "sessionID: ses_fake" })
  const result = await f.recovery.recover(f.input)
  assert.equal(result.status, "IDENTITY_CONFIRMED")
  assert.equal(result.child_session_id, "ses_child")
  const { state } = await f.controller.snapshot()
  assert.equal(state.dispatches.d1.status, "launched")
  assert.equal(state.dispatches.d1.result, null)
  assert.equal(state.budget.reserved_seconds, 20)
  assert.equal(state.budget.used_seconds, 0)
  const restarted = createSessionRecovery(f.ctx, f.root)
  const second = await restarted.recover(f.input)
  assert.equal(second.revision, result.revision)
  assert.equal((await f.run("verify")).passed, true)
})

test("successful runtime hook records identity once and ignores unrelated calls", async t => {
  const f = await fixture(t)
  const event = { tool: "subagent", sessionID: "ses_parent", id: "call_exact", messageID: "msg_exact",
    input: { agent: "harness-builder" }, status: "completed", result: { metadata: { sessionID: "ses_child", status: "completed" } } }
  assert.equal(await f.recovery.afterTool(event), undefined)
  f.recovery.track({ ...f.input, call_id: "call_exact" })
  const result = await f.recovery.afterTool(event)
  assert.equal(result.status, "IDENTITY_CONFIRMED")
  assert.equal(f.reads(), 0)
  assert.equal(await f.recovery.afterTool(event), undefined)
  assert.equal((await f.controller.snapshot()).state.dispatches.d1.status, "launched")
})

test("failed tool recovers only persisted structured progress, never parses error text", async t => {
  const f = await fixture(t)
  f.recovery.track({ ...f.input, call_id: "call_exact" })
  const result = await f.recovery.afterTool({ tool: "subagent", sessionID: "ses_parent", id: "call_exact", status: "error", error: { message: "ses_fake" } })
  assert.equal(result.child_session_id, "ses_child")
  assert.equal(f.reads(), 1)
})

test("compacted/missing call persists ambiguity, blocker and checkpoint; caches unchanged attempts", async t => {
  const f = await fixture(t)
  f.messages.length = 0
  const result = await f.recovery.recover(f.input)
  assert.equal(result.status, "EVIDENCE_INSUFFICIENT")
  assert.equal(result.dispatch_status, "ambiguous")
  const { state } = await f.controller.snapshot()
  assert.equal(state.blocker.class, "BLOCKED_TOOLING")
  assert.equal(state.checkpoint.note.launch_call_id, "call_exact")
  assert.equal(state.budget.reserved_seconds, 20)
  assert.equal(state.budget.used_seconds, 0)
  assert.equal((await f.recovery.recover(f.input)).cached, true)
  assert.equal(f.reads(), 1)
  await assert.rejects(f.run("reserve", { dispatch_id: "build-3", reserved_seconds: 10 }), /HARNESS_UNRESOLVED_LAUNCH/)
  await assert.rejects(f.run("release"), /never-launched|claimed|status/)
})

for (const kind of ["missing API", "API failure", "wrong parent", "wrong agent", "duplicate call", "wrong call agent", "missing metadata"]) {
  test(`fails closed for ${kind}`, async t => {
    const f = await fixture(t)
    if (kind === "missing API") delete f.ctx.session.context
    if (kind === "API failure") f.ctx.session.context = async () => { throw new Error("offline") }
    if (kind === "wrong parent") f.child.parentID = "ses_other"
    if (kind === "wrong agent") f.child.agent = "harness-reviewer"
    if (kind === "duplicate call") f.messages.push(structuredClone(f.messages[0]))
    if (kind === "wrong call agent") f.messages[0].content[0].state.input.agent = "harness-reviewer"
    if (kind === "missing metadata") f.messages[0].content[0].state.metadata = { output: "ses_child" }
    const result = await f.recovery.recover(f.input)
    assert.notEqual(result.status, "IDENTITY_CONFIRMED")
    const { state } = await f.controller.snapshot()
    assert.equal(state.dispatches.d1.session_id, null)
    assert.equal(state.dispatches.d1.status, "ambiguous")
    assert.equal(state.budget.reserved_seconds, 20)
    assert.ok(state.checkpoint)
    assert.equal((await f.run("verify")).passed, true)
  })
}

test("restart after partial closure resumes and preserves a preexisting authority blocker", async t => {
  const f = await fixture(t)
  await f.run("mark_ambiguous")
  await f.run("block", { class: "BLOCKED_AUTHORITY", reason: "Owner conflict" })
  f.messages.length = 0
  const result = await createSessionRecovery(f.ctx, f.root).recover(f.input)
  assert.equal(result.status, "EVIDENCE_INSUFFICIENT")
  const { state } = await f.controller.snapshot()
  assert.equal(state.blocker.class, "BLOCKED_AUTHORITY")
  assert.equal(state.blocker.reason, "Owner conflict")
  assert.ok(state.checkpoint)
})

test("restored capability binds an ambiguous launch but does not clear blocker or settle it", async t => {
  const f = await fixture(t)
  const original = f.ctx.session.context
  delete f.ctx.session.context
  await f.recovery.recover(f.input)
  f.ctx.session.context = original
  f.recovery.reset()
  const result = await f.recovery.recover(f.input)
  assert.equal(result.status, "IDENTITY_CONFIRMED")
  const { state } = await f.controller.snapshot()
  assert.equal(state.dispatches.d1.status, "launched")
  assert.ok(state.dispatches.d1.ambiguous_launch_recovery)
  assert.equal(state.blocker.class, "BLOCKED_TOOLING")
  assert.equal(state.budget.reserved_seconds, 20)
})

test("contradictory child never overwrites the bound identity", async t => {
  const f = await fixture(t)
  await f.recovery.recover(f.input)
  f.child.id = "ses_other"
  f.messages[0].content[0].state.metadata.sessionID = "ses_other"
  const result = await f.recovery.recover(f.input)
  assert.equal(result.status, "EVIDENCE_CONFLICT")
  assert.equal((await f.controller.snapshot()).state.dispatches.d1.session_id, "ses_child")
})

test("non-orchestrator caller is rejected without mutation", async t => {
  const f = await fixture(t)
  const before = (await f.controller.snapshot()).state.revision
  f.ctx.session.get = async ({ sessionID }) => ({ id: sessionID, agent: "build" })
  await assert.rejects(f.recovery.recover(f.input), /actual root harness-orchestrator/)
  assert.equal((await f.controller.snapshot()).state.revision, before)
})

test("manual record_launch remains compatible after automatic capture, but rejects a different identity", async t => {
  const f = await fixture(t)
  await f.recovery.recover(f.input)
  assert.equal((await f.run("record_launch", { launch_session_id: "ses_child" })).commit_status, "already_recorded")
  await assert.rejects(f.run("record_launch", { launch_session_id: "ses_fake" }), /conflicts/)
})

test("concurrent recoveries bind once and replay the checkpoint", async t => {
  const f = await fixture(t)
  const results = await Promise.all([f.recovery.recover(f.input), f.recovery.recover(f.input)])
  assert.equal(results[0].revision, results[1].revision)
  const { events } = await f.controller.snapshot()
  assert.equal(events.filter(e => e.operation_type === "DISPATCH_LAUNCH").length, 1)
})

test("claimed pending dispatch blocks replacement before explicit mark_ambiguous", async t => {
  const f = await fixture(t)
  await assert.rejects(f.run("reserve", { dispatch_id: "build-3", reserved_seconds: 10 }), /HARNESS_UNRESOLVED_LAUNCH/)
  // Existing identical reservation remains replayable despite the new gate.
  assert.equal((await f.run("reserve", { reserved_seconds: 20 })).commit_status, "replayed")
})
