import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.js"
import { recordKnowledgeArtifact } from "../src/project-knowledge.js"
import { seedWuContract } from "./execution/wu-fixture.js"

// Loads the actual package entry point/SDK and runs its registered hooks/tools.
// The host is controlled; this is not a real-provider canary.
async function host(t) {
  const root = await mkdtemp(join(tmpdir(), "plugin-host-"))
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = join(root, "config")
  const agents = new Map(["orchestrator", "builder", "reviewer", "researcher", "designer"].map(role =>
    [`harness-${role}`, { id: `harness-${role}`, name: `harness-${role}`, mode: role === "orchestrator" ? "primary" : "subagent" }]))
  const sessions = new Map([["ses_root", { id: "ses_root", agent: "build" }]])
  const hooks = new Map(), definitions = new Map(), storage = new Map()
  definitions.set("subagent", { name: "subagent", execute: async (_input, context) => {
    await context.progress({ sessionID: "ses_child", status: "running" })
    return { content: "child running" }
  } })
  const ctx = {
    app: { version: "2.0.25-fixture" }, location: { project: { canonical: root } },
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    agent: { list: async () => [...agents.values()], get: async ({ agentID }) => agents.get(agentID), reload: async () => {},
      transform: async fn => fn({ update: (id, fn) => { if (agents.has(id)) fn(agents.get(id)) } }) },
    session: { get: async ({ sessionID }) => sessions.get(sessionID), switchAgent: async ({ sessionID, agent }) => { sessions.get(sessionID).agent = agent },
      hook: async (name, fn) => hooks.set(`session:${name}`, fn), context: async () => [], wait: async () => {}, prompt: async () => ({}) },
    tool: { hook: async (name, fn) => hooks.set(`tool:${name}`, fn), transform: async fn => fn({ add: definition => definitions.set(definition.name, definition), update: (id, update) => { if (definitions.has(id)) update(definitions.get(id)) } }), list: async () => [...definitions.values()] },
    permission: { hook: async () => {} }, command: { transform: async fn => fn({ add: () => {} }) },
    event: { async *subscribe() {} },
  }
  const cleanup = await plugin.setup(ctx)
  t.after(async () => { cleanup(); if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = previous; await rm(root, { recursive: true, force: true }) })
  async function invoke(name, input, origin = sessions.get("ses_root").agent) {
    const event = { tool: name, id: "call", sessionID: "ses_root", agent: origin, input }
    await hooks.get("tool:execute.before")(event)
    return JSON.parse((await definitions.get(name).execute(event.input, { sessionID: "ses_root" })).content)
  }
  return { root, ctx, sessions, hooks, definitions, invoke, run: input => invoke("harness_execution_controller", { execution_id: "E", ...input }) }
}

test("whole plugin: Build transfers ownership without executing the stale call; prepare/release/prepare is usable", async t => {
  const f = await host(t)
  await assert.rejects(f.run({ action: "status" }), /HARNESS_HANDOFF_REQUIRED/)
  assert.equal(f.sessions.get("ses_root").agent, "harness-orchestrator")
  await recordKnowledgeArtifact(f.root, { artifact_type: "epic", artifact_id: "epic-001", title: "Epic", status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.com/approval"], content: 'execution_mandate: {"max_wus":1,"total_seconds":200}' })
  await seedWuContract(f.root, "WU-01", "epic-001", 200)
  await f.run({ action: "approve_mandate", epic_artifact_id: "epic-001" })
  await f.run({ action: "activate_wu", wu_id: "WU-01", mandate_id: "E-MANDATE-001" })
  for (const id of ["d1", "d2"]) {
    await f.run({ action: "reserve", dispatch_id: id, reserved_seconds: 120 })
    await f.run({ action: "prepare_launch", dispatch_id: id, launch_agent: "harness-builder" })
    if (id === "d1") await f.run({ action: "release", dispatch_id: id })
  }
  const launch = { tool: "subagent", id: "call-child", sessionID: "ses_root", agent: "harness-orchestrator", input: { agent: "harness-builder" } }
  await f.hooks.get("tool:execute.before")(launch)
  f.sessions.set("ses_child", { id: "ses_child", parentID: "ses_root", agent: "harness-builder" })
  // Parent context deliberately has no active call. Actual registered tool
  // progress must persist identity before the child's context hook runs.
  await f.definitions.get("subagent").execute(launch.input, { ...launch, progress: async () => {} })
  const request = { sessionID: "ses_child", agent: "harness-builder", system: [], options: {} }
  await f.hooks.get("session:context")(request)
  assert.match(request.system[0].text, /process_obligations/)
  assert.equal((await f.run({ action: "status" })).dispatches.find(d => d.dispatch_id === "d2").session_id, "ses_child")
  await f.hooks.get("tool:execute.after")({ ...launch, status: "completed", result: { content: "Partial work; tests still pending", metadata: { sessionID: "ses_child", status: "completed" } } })
  await f.run({ action: "record_finish", dispatch_id: "d2", result: "partial, not accepted" })
  const result = await f.run({ action: "reconcile", dispatch_id: "d2" })
  assert.ok(result.budget.used_seconds < 120)
  assert.equal(result.dispatches.find(d => d.dispatch_id === "d2").consumption_basis, "observed_wall_upper_bound")
  assert.equal(result.wu.completed, false)
  assert.equal((await f.run({ action: "verify" })).passed, true)
  await assert.rejects(f.hooks.get("tool:execute.before")({ ...launch, id: "unclaimed" }), /requires a durable prepare_launch/)
})
