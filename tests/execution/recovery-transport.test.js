// Phase 4 recovery Code-Mode transport amendment — focused regressions.
//
// Scope: identify an ACTIVE APPROVED RECOVERY ACTION that was invoked through
// Code Mode, in `beforeTool` (claim before effect) and `afterTool` (evidence
// after effect), without widening the closed Harness-tool whitelist or granting
// shell any general execute privilege.
//
// The action descriptor is the EXACT -003 restore-ready action, including its
// absolute workdir and ready.txt path, so this suite pins the real bytes.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import {
  runExecutionController,
  assertToolControllerAuthority,
  assertToolFreezeAuthority,
  assertToolVerificationAuthority,
} from "../../src/execution/controller-tool.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { verificationContractHash } from "../../src/execution/verification-contract.js"
import { sha256, stableHash } from "../../src/execution/serialize.js"
import {
  extractHarnessToolInvocation,
  extractStaticToolInvocation,
} from "../../src/execution/controller-transport.js"
import { createExecutionGuard } from "../../src/execution/runtime-guard.js"

const REPO_ROOT = "/Users/poseidon/Documents/agentic-engineering-tutor-system/agentic-engineering-tutor-system"
const READY_PATH = `${REPO_ROOT}/.harness/execution/runtime-fixtures/phase4-resolvebinary-absolute-v1/ready.txt`

// Exact -003 restore-ready action input (tool = shell). `\\n` is a literal
// backslash-n in the command, exactly as the approved bytes encode it.
export const EXACT_RECOVERY_INPUT = {
  command: `node -e 'require("node:fs").writeFileSync("${READY_PATH}","READY\\n",{flag:"wx",mode:0o600})'`,
  workdir: REPO_ROOT,
  timeout: 10000,
}

const contractText = "WU: support the approved behavior, within payload.txt only."
const sourceHash = sha256(contractText)
const verification = {
  source_wu_id: "WU-P4",
  source_wu_hash: sourceHash,
  commands: [{ id: "tooling-ready", program: process.execPath, args: ["-e", "process.exit(0)"] }],
}
const policy = {
  version: 1,
  max_repair_cycles: 1,
  wu_id: "WU-P4",
  wu_contract_path: "wu.md",
  wu_contract_hash: sourceHash,
  allowed_paths: ["payload.txt"],
  verification_contract_hash: verificationContractHash(verification),
  build_seconds: 300,
  repair_seconds: 300,
  review_seconds: 300,
  recovery_actions: [{
    id: "restore-ready",
    class: "BLOCKED_TOOLING",
    actor: "harness-builder",
    tool: "shell",
    input: EXACT_RECOVERY_INPUT,
    reserved_seconds: 120,
    success_check_id: "tooling-ready",
  }],
}

// Wrapped shell event through Code Mode. `notation` selects the observed dot or
// bracket wrapper form.
function wrappedShell(input, { notation = "dot", id = "recovery-call" } = {}) {
  const target = notation === "dot" ? "tools.shell" : 'tools["shell"]'
  return {
    sessionID: "recovery-session",
    agent: "harness-builder",
    tool: "execute",
    input: { code: `return await ${target}(${JSON.stringify(input)})` },
    id,
  }
}

function directShell(input, { id = "recovery-call" } = {}) {
  return { sessionID: "recovery-session", agent: "harness-builder", tool: "shell", input, id }
}

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-recovery-transport-"))
  try {
    await writeFile(join(root, "wu.md"), contractText)
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic",
      artifact_id: "epic-p4",
      status: "APPROVED",
      owner_confirmed: true,
      title: "Test-only Phase 4 authority",
      source_refs: ["wu.md"],
      content: `execution_mandate: ${JSON.stringify({ max_wus: 1, total_seconds: 1800, repair_policy: policy })}`,
    })
    const call = (input) => runExecutionController(root, { execution_id: "E", session_id: "owner", ...input })
    await call({ action: "approve_mandate", epic_artifact_id: "epic-p4" })
    await call({ action: "activate_wu", wu_id: "WU-P4", mandate_id: "E-MANDATE-001" })

    const registry = createCandidateRegistry({ dir: join(root, ".harness/execution") })
    await call({ action: "reserve", dispatch_id: "build", purpose: "BUILD", reserved_seconds: 300 })
    await call({ action: "prepare_launch", dispatch_id: "build" })
    await call({ action: "record_launch", dispatch_id: "build", launch_session_id: "build-session" })
    await writeFile(join(root, "payload.txt"), "A")
    const a = await freezeCandidate(root, { paths: ["payload.txt"], verification_contract: verification })
    await registry.store(a)
    await call({ action: "record_finish", dispatch_id: "build", result: "done" })
    await call({ action: "reconcile", dispatch_id: "build" })
    await call({ action: "record_candidate", candidate_id: a.candidate_id, dispatch_id: "build" })

    await call({ action: "block", blocker_id: "tooling", class: "BLOCKED_TOOLING", reason: "ready.txt absent", failure_signature: "missing-ready-txt" })
    await call({ action: "authorize_recovery", blocker_id: "tooling", recovery_action_id: "restore-ready", dispatch_id: "recovery", hypothesis: "restore the private fixture", progress_evidence_ids: ["tooling"] })
    await call({ action: "reserve", dispatch_id: "recovery", purpose: "RECOVERY", candidate_id: a.candidate_id, reserved_seconds: 120 })
    await call({ action: "prepare_launch", dispatch_id: "recovery" })
    await call({ action: "record_launch", dispatch_id: "recovery", launch_session_id: "recovery-session" })

    const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
    const snapshot = async () => {
      const core = await createExecutionController({ dir: join(root, ".harness/execution/controller/E") })
      return (await core.snapshot()).state
    }
    await fn({ root, call, guard, snapshot, candidate: a })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("regression 1-3: exact wrapped shell recovery is admitted, claimed before effect, then records PASS evidence", async () => fixture(async ({ guard, snapshot }) => {
  // The guard itself never performs the side effect; the approved path stays absent.
  await assert.rejects(access(READY_PATH), /ENOENT/)

  const event = wrappedShell(EXACT_RECOVERY_INPUT)
  const before = await snapshot()
  assert.equal(before.recoveries.tooling.action_claim, undefined)
  assert.equal(before.recoveries.tooling.action_evidence, undefined)

  await guard.beforeTool(event)
  const claimed = await snapshot()
  assert.ok(claimed.recoveries.tooling.action_claim, "claim must be persisted by beforeTool")
  assert.equal(claimed.recoveries.tooling.action_claim.tool_call_id, "recovery-call")
  assert.equal(claimed.recoveries.tooling.action_claim.action_hash, stableHash(claimed.recoveries.tooling.action), "claim binds the exact approved action")
  assert.equal(claimed.recoveries.tooling.action_evidence, undefined, "no evidence before the side effect completes")
  // Claim persisted before the effect: the guard has not written the fixture.
  await assert.rejects(access(READY_PATH), /ENOENT/)

  await guard.afterTool({ ...event, status: "completed", result: { ok: true } })
  const done = await snapshot()
  assert.equal(done.recoveries.tooling.action_evidence.status, "PASS")
  assert.equal(done.recoveries.tooling.action_evidence.tool_call_id, "recovery-call")
}))

test("regression 4: a one-character command change is rejected", async () => fixture(async ({ guard, snapshot }) => {
  const changed = { ...EXACT_RECOVERY_INPUT, command: EXACT_RECOVERY_INPUT.command.replace("mode:0o600", "mode:0o601") }
  await assert.rejects(guard.beforeTool(wrappedShell(changed)), /exact approved recovery/i)
  assert.equal((await snapshot()).recoveries.tooling.action_claim, undefined)
}))

test("regression 5: READY/newline encoding mismatch is rejected", async () => fixture(async ({ guard }) => {
  // Replace the literal backslash-n with a real newline character.
  const changed = { ...EXACT_RECOVERY_INPUT, command: EXACT_RECOVERY_INPUT.command.replace("READY\\n", "READY\n") }
  assert.notEqual(changed.command, EXACT_RECOVERY_INPUT.command)
  await assert.rejects(guard.beforeTool(wrappedShell(changed)), /exact approved recovery/i)
}))

test("regression 6-9: changed workdir, changed timeout, extra field and omitted field are rejected", async () => fixture(async ({ guard, snapshot }) => {
  const variants = [
    ["workdir", { ...EXACT_RECOVERY_INPUT, workdir: `${REPO_ROOT}/elsewhere` }],
    ["timeout", { ...EXACT_RECOVERY_INPUT, timeout: 10001 }],
    ["extra", { ...EXACT_RECOVERY_INPUT, extra: true }],
    ["omitted", { command: EXACT_RECOVERY_INPUT.command, workdir: EXACT_RECOVERY_INPUT.workdir }],
  ]
  for (const [label, input] of variants) {
    await assert.rejects(guard.beforeTool(wrappedShell(input)), /exact approved recovery/i, label)
  }
  assert.equal((await snapshot()).recoveries.tooling.action_claim, undefined)
}))

test("regression 10: arbitrary wrapped shell outside the approved recovery is rejected", async () => fixture(async ({ guard }) => {
  await assert.rejects(
    guard.beforeTool(wrappedShell({ ...EXACT_RECOVERY_INPUT, command: "chmod +x whatever" })),
    /exact approved recovery/i,
  )
  // Dynamic/aliased wrappers are structurally unrecognized and stay fail-closed.
  const dynamic = { sessionID: "recovery-session", agent: "harness-builder", tool: "execute", input: { code: 'return await tools[name]({ command: "true" })' }, id: "dyn" }
  await assert.rejects(guard.beforeTool(dynamic), /exact approved recovery/i)
}))

test("regression 11: the direct exact shell recovery still works", async () => fixture(async ({ guard, snapshot }) => {
  await guard.beforeTool(directShell(EXACT_RECOVERY_INPUT, { id: "direct-call" }))
  const claimed = await snapshot()
  assert.equal(claimed.recoveries.tooling.action_claim.tool_call_id, "direct-call")
  await guard.afterTool({ ...directShell(EXACT_RECOVERY_INPUT, { id: "direct-call" }), status: "completed", result: { ok: true } })
  assert.equal((await snapshot()).recoveries.tooling.action_evidence.status, "PASS")
}))

test("regression 12, 18: retry after action_claim is denied and the attempt is single-use", async () => fixture(async ({ guard, snapshot }) => {
  const event = wrappedShell(EXACT_RECOVERY_INPUT)
  await guard.beforeTool(event)
  await assert.rejects(guard.beforeTool({ ...event, id: "retry-1" }), /claimed|consumed/i)
  await guard.afterTool({ ...event, status: "completed", result: { ok: true } })
  await assert.rejects(guard.beforeTool({ ...event, id: "retry-2" }), /claimed|consumed/i)
  const s = await snapshot()
  assert.equal(s.recoveries.tooling.action_claim.tool_call_id, "recovery-call")
  assert.equal(s.recoveries.tooling.action_evidence.tool_call_id, "recovery-call")
}))

test("regression 13: the closed Harness-tool whitelist is not widened by the recovery path", async () => {
  // shell remains structurally recognizable but never Layer-2 normalized.
  const shellCode = `return await tools.shell(${JSON.stringify(EXACT_RECOVERY_INPUT)})`
  assert.deepEqual(extractStaticToolInvocation({ tool: "execute", input: { code: shellCode } }), { tool: "shell", input: EXACT_RECOVERY_INPUT })
  assert.equal(extractHarnessToolInvocation({ tool: "execute", input: { code: shellCode } }), null)
  // Recognized Harness wrappers still normalize unchanged.
  assert.deepEqual(
    extractHarnessToolInvocation({ tool: "execute", input: { code: 'return await tools.harness_project_status({})' } }),
    { tool: "harness_project_status", input: {} },
  )
  assert.equal(extractHarnessToolInvocation({ tool: "shell", input: { command: "true" } }), null)
})

test("regression 14, 15, 16: freeze/verification/controller boundary backstops remain transport-independent", async () => fixture(async ({ root, candidate }) => {
  // Freeze: still owner-bound and still blocked by the unresolved blocker.
  await assert.rejects(assertToolFreezeAuthority(root, { wu_id: "WU-P4" }, "owner"), /unresolved blocker/i)
  await assert.rejects(assertToolFreezeAuthority(root, { wu_id: "WU-P4" }, "intruder"), /mandate controller/i)

  // Verification: the live RECOVERY dispatch bound to this session+candidate passes;
  // an intruder or a wrong candidate fails closed.
  await assertToolVerificationAuthority(root, { candidate_id: candidate.candidate_id }, "recovery-session")
  await assert.rejects(assertToolVerificationAuthority(root, { candidate_id: candidate.candidate_id }, "intruder"), /live|bound/i)
  await assert.rejects(assertToolVerificationAuthority(root, { candidate_id: `cand-${"0".repeat(64)}` }, "recovery-session"), /live|bound/i)

  // Controller: reads are allowed for a specialist, mutations are not; owner mutates.
  await assertToolControllerAuthority(root, { action: "status", execution_id: "E", session_id: "recovery-session" })
  await assert.rejects(assertToolControllerAuthority(root, { action: "reserve", execution_id: "E", session_id: "recovery-session" }), /Specialist cannot mutate/)
  await assertToolControllerAuthority(root, { action: "checkpoint", execution_id: "E", session_id: "owner", checkpoint_id: "owner-ok" })
}))

test("regression 17: R1 — consequential owner tools cannot bypass the live dispatch/blocker policy", async () => fixture(async ({ guard }) => {
  for (const tool of ["shell", "patch", "edit", "webfetch", "execute"]) {
    await assert.rejects(guard.beforeTool({ sessionID: "owner", tool, input: {} }), /funded|reservation|dispatch|blocker|approved/i, tool)
  }
}))
