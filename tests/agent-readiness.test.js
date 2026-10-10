import test from "node:test"
import assert from "node:assert/strict"
import { assessWorkUnitAgentReadiness, checkWorkUnitAgentReadiness, guardHarnessSubagentPermission, isApprovedWorkUnitActivation } from "../src/agent-readiness.js"
import { recordArtifactWithActivationGate } from "../src/activation-gate.js"

const roles = [
  { name: "harness-builder", mode: "subagent" },
  { name: "harness-reviewer", mode: "subagent" },
]

test("accepts required agents from OpenCode's data response when both are subagents", () => {
  const result = assessWorkUnitAgentReadiness({ data: roles })
  assert.equal(result.status, "ready")
  assert.equal(result.ready, true)
  assert.deepEqual(result.missing, [])
  assert.equal(result.available.length, 2)
})

test("blocks when a required Harness role is missing", () => {
  const result = assessWorkUnitAgentReadiness({ data: [roles[0]] })
  assert.equal(result.status, "blocked")
  assert.equal(result.ready, false)
  assert.deepEqual(result.missing, ["harness-reviewer"])
})

test("blocks disabled roles and roles that cannot run as subagents", () => {
  const result = assessWorkUnitAgentReadiness([
    roles[0],
    { ...roles[1], mode: "primary" },
  ])
  assert.equal(result.status, "blocked")
  assert.deepEqual(result.wrong_mode, [{ id: "harness-reviewer", mode: "primary" }])

  const disabled = assessWorkUnitAgentReadiness([
    roles[0],
    { ...roles[1], disabled: true },
  ])
  assert.equal(disabled.ready, false)
  assert.deepEqual(disabled.missing, ["harness-reviewer"])

  const hidden = assessWorkUnitAgentReadiness({ data: [roles[0], { ...roles[1], hidden: true }] })
  assert.equal(hidden.ready, true, "OpenCode hidden agents remain callable when permission allows")
})

test("treats malformed or failed agent inventory as unknown and blocking", async () => {
  const malformed = assessWorkUnitAgentReadiness({ data: null })
  assert.equal(malformed.status, "unknown")
  assert.equal(malformed.ready, false)

  const failed = await checkWorkUnitAgentReadiness({ list: async () => { throw new Error("registry unavailable") } })
  assert.equal(failed.status, "unknown")
  assert.match(failed.blocker, /registry unavailable/)

  const unsupported = await checkWorkUnitAgentReadiness({})
  assert.equal(unsupported.status, "unknown")
  assert.equal(unsupported.ready, false)
})

test("identifies approved WU activation decisions for the hard gate", () => {
  assert.equal(isApprovedWorkUnitActivation({
    artifact_type: "decision",
    artifact_id: "D-WU-01-ACTIVATION-20260929",
    title: "Approval and bounded activation for WU-01",
    status: "APPROVED",
    content: "WU-01: ACTIVATED by explicit owner decision.",
  }), true)

  assert.equal(isApprovedWorkUnitActivation({
    artifact_type: "decision",
    artifact_id: "D-WU-01-ACTIVATION-BLOCKER",
    title: "WU-01 activation remains blocked",
    status: "DRAFT",
    content: "WU-01: NOT AUTHORIZED.",
  }), false)

  assert.equal(isApprovedWorkUnitActivation({
    artifact_type: "decision",
    artifact_id: "D-PRODUCT-CHOICE",
    title: "Choose workshop capacity",
    status: "APPROVED",
    content: "The WU can be activated after review.",
  }), false)
})

test("hard-blocks activation artifact writes when required roles are unavailable", async () => {
  let writes = 0
  const record = async () => { writes += 1; return { status: "recorded" } }
  const activation = {
    artifact_type: "decision",
    artifact_id: "D-WU-01-ACTIVATION-20260929",
    title: "Approval and bounded activation for WU-01",
    status: "APPROVED",
    content: "WU-01: ACTIVATED by explicit owner decision.",
  }

  const blocked = await recordArtifactWithActivationGate("/project", activation, {
    list: async () => ({ data: [{ name: "harness-orchestrator", mode: "primary" }] }),
  }, record)
  assert.equal(blocked.status, "blocked")
  assert.deepEqual(blocked.files_written, [])
  assert.equal(writes, 0)

  const accepted = await recordArtifactWithActivationGate("/project", activation, {
    list: async () => ({ data: roles }),
  }, record)
  assert.equal(accepted.status, "recorded")
  assert.equal(writes, 1)
})

test("does not block non-activation decisions when work-unit roles are absent", async () => {
  let writes = 0
  const result = await recordArtifactWithActivationGate("/project", {
    artifact_type: "decision",
    artifact_id: "D-PRODUCT-CAPACITY",
    title: "Approve workshop capacity",
    status: "APPROVED",
    content: "Set workshop capacity to two.",
  }, { list: async () => ({ data: [] }) }, async () => { writes += 1; return { status: "recorded" } })
  assert.equal(result.status, "recorded")
  assert.equal(writes, 1)
})

test("denies actual Harness subagent launches when the runtime registry is unavailable", async () => {
  const event = { action: "subagent", resources: ["harness-builder"], effect: "allow" }
  const result = await guardHarnessSubagentPermission(event, {
    list: async () => ({ data: [{ name: "harness-orchestrator", mode: "primary" }] }),
  })
  assert.equal(result.blocked, true)
  assert.equal(event.effect, "deny")
  assert.match(event.message, /unavailable or cannot run as subagents/)
})

test("leaves unrelated subagent launches and ready Harness roles unchanged", async () => {
  const unrelated = { action: "subagent", resources: ["docs-writer"], effect: "allow" }
  assert.equal((await guardHarnessSubagentPermission(unrelated, {})).blocked, false)
  assert.equal(unrelated.effect, "allow")

  const ready = { action: "subagent", resources: ["harness-reviewer"], effect: "ask" }
  const result = await guardHarnessSubagentPermission(ready, { list: async () => ({ data: roles }) })
  assert.equal(result.blocked, false)
  assert.equal(ready.effect, "ask")
})

test("readiness exposes loaded terminal restrictions without inventing CLI access", async () => {
  const permissions = [{ action: "shell", resource: "*", effect: "deny" }]
  const api = { list: async () => roles, get: async () => ({ id: "harness-orchestrator", permissions }) }
  let result = await checkWorkUnitAgentReadiness(api)
  assert.equal(result.ready, true)
  assert.equal(result.orchestrator_terminal.has_shell_deny, true)
  assert.deepEqual(result.orchestrator_terminal.rules, permissions)
  permissions[0].effect = "allow"
  result = await checkWorkUnitAgentReadiness(api)
  assert.equal(result.orchestrator_terminal.has_shell_deny, false)
  assert.equal(result.orchestrator_terminal.session_access, "unverified")
  const unknown = await checkWorkUnitAgentReadiness({ list: api.list })
  assert.equal(unknown.orchestrator_terminal.status, "unknown")
})

test("configured tool denial is distinguished from a shell-only denial", async () => {
  const { configuredToolDenial } = await import("../src/agent-readiness.js")
  assert.equal(configuredToolDenial({ permissions: [{ action: "shell", resource: "*", effect: "deny" }] }, "harness_run_verification"), false)
  assert.equal(configuredToolDenial({ permissions: [{ action: "harness_*", resource: "*", effect: "deny" }] }, "harness_run_verification"), true)
  assert.equal(configuredToolDenial({ permissions: [{ action: "tool", resource: "harness_run_verification", effect: "deny" }] }, "harness_run_verification"), true)
})
