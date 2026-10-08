import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDispatchHandoffReader } from "../../src/execution/dispatch-handoff.js"
import { runExecutionController, claimDispatchLaunch } from "../../src/execution/controller-tool.js"
import { createExecutionController } from "../../src/execution/execution.js"

async function fixture(t, launched = true) {
  const root = await mkdtemp(join(tmpdir(), "harness-handoff-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = { execution_id: "E1", dispatch_id: "build-2", session_id: "parent" }
  const run = (action, extra = {}) => runExecutionController(root, { ...input, action, ...extra })
  await run("init", { total_seconds: 100 })
  await run("reserve", { reserved_seconds: 20 })
  await run("prepare_launch", { launch_agent: "harness-builder" })
  await claimDispatchLaunch(root, { ...input, call_id: "call_exact" })
  if (launched) await run("record_launch", { launch_session_id: "child" })
  const controller = await createExecutionController({ dir: join(root, ".harness", "execution", "controller", "E1") })
  const child = { id: "child", parentID: "parent", agent: "harness-builder", projectID: "project", outcome: "succeeded", time: { updated: 10, idle: 10 } }
  const parent = [{ type: "assistant", id: "parent_message", content: [{ type: "tool", id: "call_exact", name: "subagent", state: {
    status: "completed", input: { agent: "harness-builder" }, metadata: { sessionID: "child", status: "completed" }, content: [{ type: "text", text: "Changes ready for review" }],
  } }] }]
  const messages = [{ type: "assistant", id: "answer", agent: "harness-builder", content: [{ type: "text", text: "Implemented change; tests passed" }] }]
  const ctx = { session: {
    get: async ({ sessionID }) => structuredClone(sessionID === "parent" ? { id: "parent", agent: "harness-orchestrator", projectID: "project" } : child),
    context: async ({ sessionID }) => structuredClone(sessionID === "parent" ? parent : messages),
    wait: async () => undefined,
  } }
  const read = extra => createDispatchHandoffReader(ctx, root, { timeoutMs: 50, idleTimeoutMs: 5 })({ ...input, ...extra })
  return { root, input, run, controller, child, parent, messages, ctx, read }
}

test("reads the bound terminal child and exact parent result without mutating execution", async t => {
  const f = await fixture(t)
  f.messages.push({ type: "user", content: "private prompt" })
  f.messages[0].content.push({ type: "reasoning", text: "private reasoning" })
  f.parent.push({ type: "assistant", content: [{ type: "tool", id: "unrelated", state: { content: "unrelated output" } }] })
  const before = await f.controller.snapshot()
  const result = await f.read()
  assert.equal(result.status, "EVIDENCE_AVAILABLE")
  assert.equal(result.terminal_observed, true)
  assert.match(result.page.content, /Implemented change/)
  assert.doesNotMatch(result.page.content, /private|unrelated/)
  assert.deepEqual(await f.controller.snapshot(), before)
})

test("exact foreground parent output survives missing child context and absent wait API", async t => {
  const f = await fixture(t)
  delete f.ctx.session.wait
  f.ctx.session.context = async ({ sessionID }) => { if (sessionID === "child") throw new Error("compacted"); return f.parent }
  const result = await f.read()
  assert.equal(result.terminal_source, "exact_parent_call")
  assert.match(result.page.content, /Changes ready/)
})

for (const outcome of ["failed", "interrupted"]) test(`exposes ${outcome} errors and partial work without settling`, async t => {
  const f = await fixture(t)
  f.child.outcome = outcome
  f.messages[0].error = { type: "ProviderError", message: "stopped after commit" }
  const result = await f.read()
  assert.equal(result.last_execution_outcome, outcome)
  assert.equal(result.terminal_observed, true)
  assert.match(result.page.content, /stopped after commit/)
  assert.equal((await f.controller.snapshot()).state.dispatches["build-2"].status, "launched")
})

test("bounded wait aborts and never mistakes an old outcome for current completion", async t => {
  const f = await fixture(t)
  let signal
  f.ctx.session.wait = async (_, options) => { signal = options.signal; return new Promise(() => {}) }
  const result = await f.read()
  assert.equal(signal.aborted, true)
  assert.equal(result.terminal_observed, false)
  assert.equal(result.idle_observation, "not_confirmed")
  f.parent[0].content[0].state.metadata.status = "running"
  assert.equal((await f.read()).terminal_observed, false)
})

for (const field of ["parentID", "agent", "projectID", "id"]) test(`rejects conflicting child ${field}`, async t => {
  const f = await fixture(t)
  f.child[field] = "other"
  assert.equal((await f.read()).status, "IDENTITY_CONFLICT")
})

test("missing API, unresolved identity and unavailable child have actionable distinct results", async t => {
  const f = await fixture(t, false)
  assert.equal((await f.read()).status, "IDENTITY_REQUIRED")
  await f.run("record_launch", { launch_session_id: "child" })
  f.ctx.session.get = async ({ sessionID }) => { if (sessionID === "child") throw new Error("missing"); return { id: "parent", agent: "harness-orchestrator" } }
  assert.equal((await f.read()).status, "SESSION_UNAVAILABLE")
  delete f.ctx.session.context
  assert.equal((await f.read()).status, "CAPABILITY_UNAVAILABLE")
})

test("build caller cannot read through the orchestrator tool", async t => {
  const f = await fixture(t)
  f.ctx.session.get = async () => ({ id: "parent", agent: "build" })
  await assert.rejects(f.read(), /actual root harness-orchestrator/)
})

test("duplicate or contradictory parent evidence is rejected", async t => {
  const f = await fixture(t)
  f.parent.push(structuredClone(f.parent[0]))
  assert.equal((await f.read()).status, "EVIDENCE_CONFLICT")
  f.parent.pop()
  f.parent[0].content[0].state.metadata.sessionID = "other"
  assert.equal((await f.read()).status, "EVIDENCE_CONFLICT")
})

test("paged evidence reconstructs full result and rejects changed snapshots", async t => {
  const f = await fixture(t)
  f.messages[0].content[0].text = "verified change ".repeat(300)
  const whole = await f.read({ max_chars: 40000 })
  let page = await f.read({ max_chars: 1000 })
  let content = page.page.content
  while (page.page.next_offset !== null) {
    page = await f.read({ max_chars: 1000, offset: page.page.next_offset, evidence_hash: page.evidence_hash })
    content += page.page.content
  }
  assert.equal(content, whole.page.content)
  await assert.rejects(f.read({ offset: 1000 }), /evidence_hash is required/)
  f.messages[0].content[0].text += "changed"
  assert.equal((await f.read({ offset: 1000, evidence_hash: whole.evidence_hash })).status, "SNAPSHOT_CHANGED")
})

test("session changing during observation cannot establish terminal evidence", async t => {
  const f = await fixture(t)
  f.ctx.session.wait = async () => { f.child.time.updated++ }
  assert.equal((await f.read()).status, "SNAPSHOT_CHANGED")
})

test("terminal without handoff is explicitly distinguished from evidence", async t => {
  const f = await fixture(t)
  f.messages.length = 0
  f.parent.length = 0
  const result = await f.read()
  assert.equal(result.status, "TERMINAL_WITHOUT_HANDOFF")
  assert.match(result.evidence_scope, /Missing output does not prove/)
})

test("blocked launched dispatch can be read then explicitly finished and reconciled once", async t => {
  const f = await fixture(t)
  await f.run("block", { class: "BLOCKED_TOOLING", reason: "Missing child handoff reader" })
  const before = await f.controller.snapshot()
  const result = await f.read()
  assert.deepEqual(await f.controller.snapshot(), before)
  assert.equal(result.terminal_observed, true)
  await f.run("clear_blocker", { resolution: `Read child handoff ${result.evidence_hash}; missing reader resolved` })
  await f.run("record_finish", { result: { outcome: result.last_execution_outcome, evidence_hash: result.evidence_hash } })
  await f.run("reconcile")
  const settled = await f.controller.snapshot()
  assert.equal(settled.state.budget.reserved_seconds, 0)
  assert.equal(settled.state.budget.used_seconds, 20)
  await f.run("reconcile")
  assert.deepEqual((await f.controller.snapshot()).state, settled.state)
  assert.equal((await f.run("verify")).passed, true)
})
