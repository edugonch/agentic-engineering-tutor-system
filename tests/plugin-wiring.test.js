import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createCandidateRegistry } from "../src/execution/candidate-registry.js"
import plugin from "../index.js"
import { recordKnowledgeArtifact } from "../src/project-knowledge.js"
import { seedWuContract } from "./execution/wu-fixture.js"

// Loads the actual package entry point/SDK and runs its registered hooks/tools.
// The host is controlled; this is not a real-provider canary.
async function host(t, supervisorFlag, { agentReload = async () => {} } = {}) {
  const previousSupervisor = process.env.HARNESS_SUPERVISOR_ENABLED
  if (supervisorFlag === undefined) delete process.env.HARNESS_SUPERVISOR_ENABLED
  else process.env.HARNESS_SUPERVISOR_ENABLED = supervisorFlag
  t.after(() => { if (previousSupervisor === undefined) delete process.env.HARNESS_SUPERVISOR_ENABLED; else process.env.HARNESS_SUPERVISOR_ENABLED = previousSupervisor })
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
    agent: { list: async () => [...agents.values()], get: async ({ agentID }) => agents.get(agentID), reload: agentReload,
      transform: async fn => fn({ update: (id, fn) => { if (agents.has(id)) fn(agents.get(id)) } }) },
    session: { get: async ({ sessionID }) => sessions.get(sessionID), switchAgent: async ({ sessionID, agent }) => { sessions.get(sessionID).agent = agent },
      interrupt: async () => {}, hook: async (name, fn) => hooks.set(`session:${name}`, fn), context: async () => [], wait: async () => {}, prompt: async () => ({}) },
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
  assert.equal(JSON.parse((await f.definitions.get("harness_check_agent_readiness").execute({})).content).supervisor.enabled, true)
  await assert.rejects(f.run({ action: "status" }), /HARNESS_HANDOFF_REQUIRED/)
  assert.equal(f.sessions.get("ses_root").agent, "harness-orchestrator")
  await recordKnowledgeArtifact(f.root, { artifact_type: "epic", artifact_id: "epic-001", title: "Epic", status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.com/approval"], content: 'execution_mandate: {"max_wus":1,"total_seconds":200}' })
  await seedWuContract(f.root, "WU-01", "epic-001", 200)
  await f.run({ action: "approve_mandate", epic_artifact_id: "epic-001" })
  await f.run({ action: "activate_wu", wu_id: "WU-01", mandate_id: "E-MANDATE-001" })
  for (const id of ["d1", "d2"]) {
    await f.run({ action: "reserve", dispatch_id: id, reserved_seconds: id === "d2" ? 200 : 120 })
    await f.run({ action: "prepare_launch", dispatch_id: id, launch_agent: "harness-builder" })
    if (id === "d1") await f.run({ action: "release", dispatch_id: id })
  }
  const launch = { tool: "subagent", id: "call-child", sessionID: "ses_root", agent: "harness-orchestrator", input: { agent: "harness-builder" } }
  assert.equal((await f.invoke("harness_check_execution_readiness", { wu_id: "WU-01" })).status, "BLOCKED_BUDGET")
  const verificationTool = f.definitions.get("harness_run_verification")
  f.definitions.delete("harness_run_verification")
  await assert.rejects(f.hooks.get("tool:execute.before")(launch), /LAUNCH_CAPABILITY_BLOCKED/)
  assert.equal((await f.run({ action: "status" })).dispatches.find(d => d.dispatch_id === "d2").session_id, null)
  f.definitions.set("harness_run_verification", verificationTool)
  await f.hooks.get("tool:execute.before")(launch)
  f.sessions.set("ses_child", { id: "ses_child", parentID: "ses_root", agent: "harness-builder" })
  // Parent context deliberately has no active call. Actual registered tool
  // progress must persist identity before the child's context hook runs.
  await f.definitions.get("subagent").execute(launch.input, { ...launch, progress: async () => {} })
  await writeFile(join(f.root, "AGENTS.md"), "Use One CLI for live Drive authority.")
  const request = { sessionID: "ses_child", agent: "harness-builder", system: [], options: {} }
  await f.hooks.get("session:context")(request)
  assert.match(request.system[0].text, /process_obligations/)
  assert.ok(request.system.some(part => part.text.includes("Use One CLI for live Drive authority.")))
  assert.ok(f.definitions.has("harness_read_external_source"))
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


test("whole plugin: explicit supervisor zero disables automatic continuation", async t => {
  const f = await host(t, "0")
  const readiness = JSON.parse((await f.definitions.get("harness_check_agent_readiness").execute({})).content)
  assert.equal(readiness.supervisor.enabled, false)
})

test("plugin setup completes without waiting for a hung agent.reload", async t => {
  let timeout
  try {
    const fixture = await Promise.race([
      host(t, "0", { agentReload: () => new Promise(() => {}) }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Location plugin setup blocked on agent.reload")), 3000)
      }),
    ])
    assert.ok(fixture.definitions.has("harness_execution_controller"))
    assert.ok(fixture.definitions.has("harness_check_agent_readiness"))
  } finally {
    clearTimeout(timeout)
  }
})

// The runtime guidance must survive stale/custom profiles preserved by the
// agent provisioner; it does not alter any owner approvals or controller log.
test("plugin exposes loaded fingerprint and injects autonomy guard into root context", async t => {
  const f = await host(t, "0")
  const readiness = JSON.parse((await f.definitions.get("harness_check_agent_readiness").execute({})).content)
  assert.equal(typeof readiness.plugin_revision, "string")
  assert.ok(readiness.plugin_revision.length > 0)
  const event = { sessionID: "ses_root", agent: "harness-orchestrator", system: [], options: {} }
  await f.hooks.get("session:context")(event)
  const guidance = event.system.map(p => p.text).join("\n")
  assert.match(guidance, /WU_PLANNING_ESTIMATES/)
  assert.match(guidance, /inspect_authority_gap/)
  assert.match(guidance, /Do not ask the owner to create the technical design/)
})


test("RED plugin: freeze candidate captures the moved root session worktree, not stale canonical files", async t => {
  const f = await host(t)
  const git = (...args) => execFileSync("git", args, { cwd: f.root, encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.name", "Harness plugin test")
  git("config", "user.email", "harness@example.invalid")
  await writeFile(join(f.root, "README.md"), "# Canonical checkout\\n")
  git("add", "README.md")
  git("commit", "-qm", "canonical")
  const linked = join(f.root, "moved-session-wt")
  git("worktree", "add", "-q", "--detach", linked, "HEAD")

  await assert.rejects(f.run({ action: "status" }), /HARNESS_HANDOFF_REQUIRED/)
  await recordKnowledgeArtifact(f.root, { artifact_type: "epic", artifact_id: "epic-moved",
    title: "Approved fixture", status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.com/harness-owner"], content:
    'execution_mandate: {"max_wus":1,"total_seconds":3600,"merge_policy":"none","required_ci_checks":[],"wu_sequence":["WU-MOVED"]}',
  })
  await seedWuContract(f.root, "WU-MOVED", "epic-moved", 3600)
  await f.run({ action: "approve_mandate", epic_artifact_id: "epic-moved" })
  await f.run({ action: "activate_wu", wu_id: "WU-MOVED", mandate_id: "E-MANDATE-001" })
  await mkdir(join(linked, "docs"), { recursive: true })
  await writeFile(join(linked, "docs/ONLY-IN-MOVED-SESSION.md"), "# The actual WU output\\n")
  f.sessions.get("ses_root").location = { directory: linked }
  const result = JSON.parse((await f.definitions.get("harness_freeze_candidate").execute({
    wu_id: "WU-MOVED", overlay_paths: ["docs/ONLY-IN-MOVED-SESSION.md"],
  }, { sessionID: "ses_root" })).content)
  const registry = createCandidateRegistry({ dir: join(f.root, ".harness/execution") })
  const candidate = await registry.load(result.candidate_id)
  assert.ok(candidate.overlay.some(entry => entry.path === "docs/ONLY-IN-MOVED-SESSION.md"))
  assert.equal(candidate.overlay.find(entry => entry.path === "docs/ONLY-IN-MOVED-SESSION.md").type, "file")
  assert.equal(candidate.base?.commit ?? null, null)
})
