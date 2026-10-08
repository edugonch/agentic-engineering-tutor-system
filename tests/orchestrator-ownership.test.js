import test from "node:test"
import assert from "node:assert/strict"
import { createOrchestratorOwnership, ORCHESTRATOR } from "../src/orchestrator-ownership.js"
import { registerHarnessCommand } from "../src/bootstrap-command.js"

function fixture() {
  const sessions = new Map([["root", { id: "root", agent: "build" }]])
  const storage = new Map()
  const switches = []
  const prompts = []
  const commands = []
  const ctx = {
    agent: { get: async () => ({ id: ORCHESTRATOR, mode: "primary", disabled: false }) },
    session: {
      get: async ({ sessionID }) => structuredClone(sessions.get(sessionID)),
      switchAgent: async ({ sessionID, agent }) => { switches.push({ sessionID, agent }); sessions.get(sessionID).agent = agent },
      prompt: async input => prompts.push({ ...input, actualAgent: sessions.get(input.sessionID).agent }),
    },
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    command: { transform: async cb => cb({ add: command => commands.push(command) }) },
  }
  const event = (agent = "build", tool = "harness_execution_controller", input = { action: "bind_pr" }, sessionID = "root") => ({ agent, tool, input, sessionID })
  return { ctx, sessions, switches, prompts, commands, event, ownership: createOrchestratorOwnership(ctx) }
}

test("/harness resume switches the actual root before submitting prompt and preserves attachments", async () => {
  const f = fixture()
  await registerHarnessCommand(f.ctx, f.ownership)
  const parts = [{ type: "file", url: "file:///brief.md" }]
  await f.commands[0].execute({ sessionID: "root", prompt: { text: "resume EPIC03", parts }, delivery: "steer" })
  assert.equal(f.prompts[0].actualAgent, ORCHESTRATOR)
  assert.equal(f.prompts[0].sessionID, "root")
  assert.deepEqual(f.prompts[0].parts, parts)
  assert.match(f.prompts[0].text, /Do not restart intake/)
  assert.match(f.prompts[0].text, /EPIC03/)
})

test("direct tool from build transfers once and never executes queued old-agent mutations", async () => {
  const f = fixture()
  let mutations = 0
  const execute = async event => { await f.ownership.beforeTool(event); mutations++ }
  const events = [f.event(), f.event(), f.event()]
  const results = await Promise.allSettled(events.map(execute))
  assert.ok(results.every(r => r.status === "rejected" && r.reason.code === "HARNESS_HANDOFF_REQUIRED"))
  assert.equal(f.switches.length, 1)
  assert.equal(mutations, 0)
  await execute(f.event(ORCHESTRATOR))
  assert.equal(mutations, 1)
})

test("actual runtime identity, not supplied session_id, determines the lease holder", async () => {
  const f = fixture()
  await f.ownership.takeOwnership("root")
  await assert.rejects(f.ownership.beforeTool(f.event(ORCHESTRATOR, undefined, { action: "block", session_id: "victim" })), { code: "HARNESS_SESSION_MISMATCH" })
  const e = f.event(ORCHESTRATOR)
  await f.ownership.beforeTool(e)
  assert.equal(e.input.session_id, "root")
  await assert.rejects(f.ownership.beforeTool(f.event(null)), { code: "HARNESS_IDENTITY_UNKNOWN" })
})

test("child specialists retain evidence tools but cannot mutate governance or take over", async () => {
  const f = fixture()
  await f.ownership.takeOwnership("root")
  for (const agent of ["harness-builder", "harness-designer", "harness-reviewer", "harness-researcher"]) {
    f.sessions.set(agent, { id: agent, agent, parentID: "root" })
    await f.ownership.beforeTool(f.event(agent, "harness_read_project_knowledge", {}, agent))
    await assert.rejects(f.ownership.beforeTool(f.event(agent, "harness_execution_controller", { action: "complete" }, agent)), { code: "HARNESS_ROLE_DENIED" })
    await assert.rejects(f.ownership.takeOwnership(agent), { code: "HARNESS_ROLE_DENIED" })
    if (agent !== "harness-researcher") await f.ownership.beforeTool(f.event(agent, "harness_run_verification", {}, agent))
  }
  await assert.rejects(f.ownership.beforeTool(f.event("harness-reviewer", "harness_freeze_candidate", {}, "harness-reviewer")), { code: "HARNESS_ROLE_DENIED" })
  assert.equal(f.switches.length, 1)
})

test("restart preserves ownership and a later user prompt restores the selected primary", async () => {
  const f = fixture()
  await f.ownership.takeOwnership("root")
  f.sessions.get("root").agent = "build"
  const restarted = createOrchestratorOwnership(f.ctx)
  await restarted.onPrompt({ sessionID: "root" })
  assert.equal(f.sessions.get("root").agent, ORCHESTRATOR)
  f.sessions.set("unrelated", { id: "unrelated", agent: "build" })
  await restarted.onPrompt({ sessionID: "unrelated" })
  assert.equal(f.sessions.get("unrelated").agent, "build")
})

test("missing, disabled, or wrong-mode orchestrator fails before prompt admission", async () => {
  for (const profile of [null, { mode: "subagent" }, { mode: "primary", disabled: true }]) {
    const f = fixture()
    f.ctx.agent.get = async () => profile
    await registerHarnessCommand(f.ctx, f.ownership)
    await assert.rejects(f.commands[0].execute({ sessionID: "root", prompt: { text: "resume" } }), { code: "HARNESS_ORCHESTRATOR_UNAVAILABLE" })
    assert.equal(f.prompts.length, 0)
    assert.equal(f.switches.length, 0)
  }
})

test("failed switch neither admits a prompt nor poisons retry serialization", async () => {
  const f = fixture()
  const original = f.ctx.session.switchAgent
  f.ctx.session.switchAgent = async () => { throw new Error("switch failed") }
  await assert.rejects(f.ownership.takeOwnership("root"), /switch failed/)
  f.ctx.session.switchAgent = original
  await f.ownership.takeOwnership("root")
  assert.equal(f.sessions.get("root").agent, ORCHESTRATOR)
})

test("a reported switch that did not change runtime state fails closed", async () => {
  const f = fixture()
  f.ctx.session.switchAgent = async () => {}
  await assert.rejects(f.ownership.takeOwnership("root"), { code: "HARNESS_HANDOFF_FAILED" })
})

test("build cannot start a harness specialist without transferring first", async () => {
  const f = fixture()
  await assert.rejects(f.ownership.beforeTool(f.event("build", "subagent", { agent: "harness-builder" })), { code: "HARNESS_HANDOFF_REQUIRED" })
  assert.equal(f.sessions.get("root").agent, ORCHESTRATOR)
})

test("takeover prevents old build shell/edit batch from executing, leaving specialist work intact", async () => {
  const f = fixture()
  await f.ownership.takeOwnership("root")
  for (const tool of ["bash", "edit", "write", "subagent"]) {
    await assert.rejects(f.ownership.beforeTool(f.event("build", tool)), { code: "HARNESS_HANDOFF_REQUIRED" })
  }
  f.sessions.set("worker", { id: "worker", agent: "harness-builder", parentID: "root" })
  await f.ownership.beforeTool(f.event("harness-builder", "edit", {}, "worker"))
})
