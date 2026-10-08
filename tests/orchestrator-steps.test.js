import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { registerOrchestratorSteps, inspectOrchestratorSteps, readOrchestratorStepLimit } from "../src/orchestrator-steps.js"
import { provisionGlobalHarnessAgents } from "../src/global-agent-provisioner.js"
import { createTurnGuard } from "../src/turn-guard.js"
import { runExecutionController } from "../src/execution/controller-tool.js"

const ID = "harness-orchestrator"
function runtime(profiles) {
  const transforms = []
  let loaded
  return {
    transform: async fn => { transforms.push(fn) },
    reload: async () => {
      loaded = structuredClone(profiles)
      for (const fn of transforms) fn({ update: (id, update) => { if (loaded[id]) update(loaded[id]) } })
    },
    get: async ({ agentID }) => ({ data: loaded[agentID] }),
  }
}

test("legacy merged project limit is removed across reloads without changing other fields or specialists", async () => {
  const profiles = {
    [ID]: { id: ID, mode: "primary", steps: 12, model: { id: "owner-model" }, permissions: [{ action: "edit", effect: "deny" }] },
    "harness-builder": { id: "harness-builder", steps: 20 },
    build: { id: "build", steps: 12 },
  }
  const api = runtime(profiles)
  await registerOrchestratorSteps(api)
  for (let i = 0; i < 2; i++) {
    await api.reload()
    const current = (await api.get({ agentID: ID })).data
    const expected = { ...profiles[ID] }; delete expected.steps
    assert.deepEqual(current, expected)
    assert.equal((await api.get({ agentID: "harness-builder" })).data.steps, 20)
    assert.equal((await api.get({ agentID: "build" })).data.steps, 12)
    assert.equal((await inspectOrchestratorSteps(api)).status, "no_step_limit")
  }
  assert.equal(profiles[ID].steps, 12) // local config remains untouched
})

test("custom non-legacy limits and explicit opt-in 12 are preserved and reported", async () => {
  for (const [configured, env, expected] of [[30, {}, 30], [12, { HARNESS_ORCHESTRATOR_MAX_STEPS: "12" }, 12], [undefined, { HARNESS_ORCHESTRATOR_MAX_STEPS: "25" }, 25]]) {
    const api = runtime({ [ID]: { id: ID, steps: configured } })
    await registerOrchestratorSteps(api, env)
    await api.reload()
    const result = await inspectOrchestratorSteps(api)
    assert.equal(result.status, "configured_step_limit")
    assert.equal(result.effective_steps, expected)
  }
})

test("invalid opt-in limits fail instead of silently disabling a requested cap", () => {
  for (const value of ["0", "-1", "abc", "12x", "1.5", "9007199254740992"]) {
    assert.throws(() => readOrchestratorStepLimit({ HARNESS_ORCHESTRATOR_MAX_STEPS: value }), /positive integer/)
  }
  assert.equal(readOrchestratorStepLimit({}), null)
})

test("missing runtime inventory is unknown, never reported as unlimited", async () => {
  assert.equal((await inspectOrchestratorSteps({ get: async () => null })).status, "unknown")
  assert.equal((await inspectOrchestratorSteps({ get: async () => { throw new Error("offline") } })).status, "unknown")
})

test("package provisioning upgrades a managed legacy orchestrator and preserves local customizations", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-step-profiles-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = fileURLToPath(new URL("../", import.meta.url))
  const configDir = join(root, "config")
  await provisionGlobalHarnessAgents({ packageRoot, configDir })
  const target = join(configDir, "agents", `${ID}.md`)
  const current = await readFile(target, "utf8")
  assert.doesNotMatch(current.split("---")[1], /^steps:/m)
  // Seed an authentic managed old version and its ownership fingerprint.
  const { createHash } = await import("node:crypto")
  const legacy = current.replace("mode: primary\n", "mode: primary\nsteps: 12\n")
  await writeFile(target, legacy)
  const manifestPath = join(configDir, "agents", ".agentic-harness-managed-agents.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.files[ID].sha256 = createHash("sha256").update(legacy).digest("hex")
  await writeFile(manifestPath, JSON.stringify(manifest))
  assert.ok((await provisionGlobalHarnessAgents({ packageRoot, configDir })).updated.includes(ID))
  assert.equal(await readFile(target, "utf8"), current)
  await writeFile(target, `${legacy}\nOwner custom prompt\n`)
  assert.ok((await provisionGlobalHarnessAgents({ packageRoot, configDir })).preserved.some(x => x.id === ID))
  assert.match(await readFile(target, "utf8"), /Owner custom prompt/)
})

test("simulated model/tool steps pass twelve and reach a durable checkpoint; guards still reject repeated mutations", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-steps-run-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const api = runtime({ [ID]: { id: ID, steps: 12 } })
  await registerOrchestratorSteps(api)
  await api.reload()
  const profile = (await api.get({ agentID: ID })).data
  const guard = createTurnGuard()
  const input = { execution_id: "step-test", session_id: "ses_owner" }
  await runExecutionController(root, { ...input, action: "init", total_seconds: 100 })
  for (let step = 1; step <= 15; step++) {
    // OpenCode's documented final-step rule; this is a simulated runtime,
    // not evidence of an authenticated provider-backed execution.
    assert.equal(profile.steps !== undefined && step >= profile.steps, false)
    guard.before({ sessionID: input.session_id, tool: "harness_execution_controller" }, { args: { action: "status" } })
    await runExecutionController(root, { ...input, action: "status" })
  }
  const result = await runExecutionController(root, { ...input, action: "checkpoint", checkpoint_id: "after-15", note: "Reached durable transition" })
  assert.equal(result.checkpoint.note, "Reached durable transition")
  for (let i = 0; i < 4; i++) guard.before({ sessionID: "s", tool: "edit" }, { args: { same: true } })
  assert.throws(() => guard.before({ sessionID: "s", tool: "edit" }, { args: { same: true } }), /repeated/)
})
