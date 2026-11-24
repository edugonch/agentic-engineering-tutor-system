// Project-governance closure/activation gates: unit + real controller actions.
// Synthetic projects only; no real Epic state is touched.
import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { applyEvent, initialState } from "../../src/execution/state.js"
import {
  loadProjectGovernance,
  resolveClosureCandidate,
  runProjectGovernanceGate,
} from "../../src/execution/project-governance.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"

const sha = (c) => c.repeat(40)
const CLOSURE_STATUS = "process.exit(process.env.HARNESS_EPIC_ID === 'EPIC-TEST' ? 0 : 1)"
const CLOSURE_FAILURE = "process.exit(1)"

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-governance-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

async function writeConfig(root, governance) {
  await writeFile(join(root, "harness.config.json"), JSON.stringify({ governance }, null, 2))
}

async function events(root, executionId = "E1") {
  const text = await readFile(join(root, ".harness", "execution", "controller", executionId, "events.ndjson"), "utf8")
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

// Build a durable, fully-completed single-WU execution (the terminal WU is done
// and a human merge is recorded) without touching any real project.
async function completedExecution(root, { epicId = "EPIC-TEST", headSha = sha("a"), mergeSha = sha("b"), closureRequired = false, governanceConfigSha256 = null } = {}) {
  const dir = join(root, ".harness", "execution", "controller", "E1")
  const c = await createExecutionController({ dir })
  const commit = async (type, body) => {
    const lease = await c.acquire("root")
    const { state } = await c.snapshot()
    return c.commit({ operation_id: `t:${state.revision}`, operation_type: type, body }, {
      holder_session_id: "root", expected_revision: state.revision, lease_fencing_token: lease.fencing_token,
    })
  }
  await commit("MANDATE_APPROVE", {
    execution_id: "E1", mandate_id: "M1", total_seconds: 100, max_wus: 1,
    authority_kind: "OWNER_APPROVED_EPIC", source_artifact_id: "epic-test",
    source_record_key: "record", source_hash: "hash",
    wu_sequence: ["WU1"], merge_policy: "human", ...(epicId ? { epic_id: epicId } : {}),
    ...(closureRequired ? { governance_closure_required: true } : {}),
    ...(governanceConfigSha256 ? { governance_config_sha256: governanceConfigSha256 } : {}),
  })
  await commit("WU_ACTIVATE", { wu_id: "WU1", mandate_id: "M1" })
  await commit("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 10 })
  await commit("DISPATCH_PREPARE", { dispatch_id: "d1", expected_agent: "harness-builder", prepared_by_session_id: "root", claim_required: false })
  await commit("DISPATCH_LAUNCH", { dispatch_id: "d1", session_id: "child-1" })
  await commit("DISPATCH_FINISH", { dispatch_id: "d1", result: "done" })
  await commit("DISPATCH_RECONCILE", { dispatch_id: "d1" })
  await commit("FREEZE_CANDIDATE", { candidate_id: "c1", wu_id: "WU1", manifest_hash: "m1", tree_hash: "t1", required_check_ids: [], verification_contract_hash: null })
  await commit("RECORD_REVIEW", { candidate_id: "c1", candidate_hashes: { manifest_hash: "m1", tree_hash: "t1" }, verdict: "PASS", verification_evidence_ids: ["receipt-1"], verified_check_ids: [], verification_contract_hash: null })
  await commit("BIND_PR", { repository: "edugonch/alfran-web-platform", pr_number: 42, candidate_id: "c1", head_sha: headSha, base_branch: "main", base_sha: sha("c") })
  await commit("MERGE_EXTERNAL_RECORD", { merge_commit_sha: mergeSha, merged_head_sha: headSha })
  await commit("MERGE_VERIFY", {})
  await commit("WU_COMPLETE", { candidate_id: "c1" })
  return c
}

test("no config file is the backward-compatible no-gate state", async () => {
  await withRoot(async (root) => {
    const governance = await loadProjectGovernance(root)
    assert.equal(governance.path, null)
    assert.equal(governance.activation, null)
    assert.equal(governance.closure, null)
    assert.equal(await runProjectGovernanceGate({ projectRoot: root, phase: "closure", epicId: "EPIC-X", config: governance }), null)
  })
})

test("malformed or unsafe config fails closed instead of silently disabling the gate", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "harness.config.json"), "{ not json")
    await assert.rejects(loadProjectGovernance(root), /not valid JSON/)
    await writeFile(join(root, "harness.config.json"), JSON.stringify({ governance: { epicClosureCommand: { program: "", args: [] } } }))
    await assert.rejects(loadProjectGovernance(root), /program must be a non-empty string/)
    await writeFile(join(root, "harness.config.json"), JSON.stringify({ governance: { epicClosureCommand: { program: "node", args: [1] } } }))
    await assert.rejects(loadProjectGovernance(root), /args must be an array of strings/)
    await writeFile(join(root, "harness.config.json"), JSON.stringify({ governance: { epicClosureCmd: { program: "node" } } }))
    await assert.rejects(loadProjectGovernance(root), /unknown key governance.epicClosureCmd/)
    await writeFile(join(root, "harness.config.json"), JSON.stringify({ governance: { epicClosureCommand: null } }))
    await assert.rejects(loadProjectGovernance(root), /cannot be null/)
    await writeFile(join(root, "harness.config.json"), JSON.stringify({ governance: { epicClosureCommand: { program: "node", extra: 1 } } }))
    await assert.rejects(loadProjectGovernance(root), /unknown key governance.epicClosureCommand.extra/)
    const real = join(root, "real-config.json")
    await writeFile(real, JSON.stringify({ governance: {} }))
    await rm(join(root, "harness.config.json"), { force: true })
    await symlink(real, join(root, "harness.config.json"))
    await assert.rejects(loadProjectGovernance(root), /must be a regular file/)
  })
})

test("closure gate runs in the project root with durable Epic and candidate identity", async () => {
  await withRoot(async (root) => {
    await writeConfig(root, { epicClosureCommand: { program: "node", args: ["-e", CLOSURE_STATUS], timeout_ms: 30000 } })
    const governance = await loadProjectGovernance(root)
    const state = { mandate: { wu_sequence: ["WU1"] }, completed_wus: { WU1: { candidate_id: "c1" } }, merges: { c1: { merge_commit_sha: sha("b") } }, pr_binding: { head_sha: sha("a") } }
    assert.deepEqual(resolveClosureCandidate(state), { final_wu_id: "WU1", candidate_id: "c1", candidate_sha: sha("b"), merge_commit_sha: sha("b") })
    const receipt = await runProjectGovernanceGate({ projectRoot: root, phase: "closure", epicId: "EPIC-TEST", executionId: "E1", mandateId: "M1", state, config: governance })
    assert.equal(receipt.ok, true)
    assert.equal(receipt.exit_code, 0)
    assert.equal(receipt.epic_id, "EPIC-TEST")
    assert.equal(receipt.candidate_sha, sha("b"))
    assert.match(receipt.stdout_sha256, /^[a-f0-9]{64}$/)
    assert.match(receipt.config_sha256, /^[a-f0-9]{64}$/)
    assert.equal(receipt.timeout_ms, 30000)
    assert.equal(receipt.stdout_tail, undefined)
    assert.ok(receipt.checked_at)
  })
})

test("gate failures, missing identity and stale/mismatched candidates are rejected", async () => {
  await withRoot(async (root) => {
    await writeConfig(root, { epicClosureCommand: { program: "node", args: ["-e", CLOSURE_FAILURE] } })
    const governance = await loadProjectGovernance(root)
    const state = { mandate: { wu_sequence: ["WU1"] }, merges: { c1: { merge_commit_sha: sha("b") } }, pr_binding: { candidate_id: "c1", head_sha: sha("a") } }
    await assert.rejects(
      runProjectGovernanceGate({ projectRoot: root, phase: "closure", epicId: "EPIC-TEST", state, config: governance }),
      (error) => error.code === "EPIC_CLOSURE_GATE_FAILED" && error.gate_receipt.exit_code === 1 &&
        typeof error.gate_diagnostic.stderr_tail === "string" && error.gate_receipt.stderr_tail === undefined,
    )
    await assert.rejects(
      runProjectGovernanceGate({ projectRoot: root, phase: "closure", epicId: null, state, config: governance }),
      (error) => error.code === "EPIC_GATE_MISSING_EPIC_ID",
    )
    await assert.rejects(
      runProjectGovernanceGate({ projectRoot: root, phase: "closure", epicId: "EPIC-TEST", state: { mandate: {} }, config: governance }),
      (error) => error.code === "EPIC_GATE_MISSING_CANDIDATE_SHA",
    )
    // A command that only accepts EPIC-TEST rejects a different Epic ID.
    await writeConfig(root, { epicClosureCommand: { program: "node", args: ["-e", CLOSURE_STATUS] } })
    const wrongEpic = await loadProjectGovernance(root)
    await assert.rejects(
      runProjectGovernanceGate({ projectRoot: root, phase: "closure", epicId: "EPIC-OTHER", state, config: wrongEpic }),
      (error) => error.code === "EPIC_CLOSURE_GATE_FAILED",
    )
  })
})

test("arguments are passed as argv, never interpreted by a shell", async () => {
  await withRoot(async (root) => {
    const payload = "a b; touch pwned; $(touch pwned2)"
    // Literal JSON braces are not placeholders; only identifier-shaped braces are.
    const script = 'const v=JSON.parse(\'{"ok":1}\').ok; process.exit(v===1?0:1)'
    await writeConfig(root, { epicClosureCommand: { program: "node", args: ["-e", script, payload] } })
    const governance = await loadProjectGovernance(root)
    const receipt = await runProjectGovernanceGate({ projectRoot: root, phase: "closure", epicId: "EPIC-TEST", state: { merge: { merge_commit_sha: sha("b") } }, config: governance })
    assert.equal(receipt.ok, true)
    assert.equal(existsSync(join(root, "pwned")), false)
    assert.equal(existsSync(join(root, "pwned2")), false)
  })
})

test("real complete action runs the closure gate and records an auditable receipt", async () => {
  await withRoot(async (root) => {
    await writeConfig(root, { epicClosureCommand: { program: "node", args: ["-e", CLOSURE_STATUS] } })
    const original = await readFile(join(root, "harness.config.json"))
    const pinned = createHash("sha256").update(original).digest("hex")
    await completedExecution(root, { closureRequired: true, governanceConfigSha256: pinned })
    const result = await runExecutionController(root, { action: "complete", execution_id: "E1", session_id: "root" })
    assert.equal(result.commit_status, "committed")
    assert.equal(result.governance.gate, "epic-closure")
    assert.equal(result.governance.epic_id, "EPIC-TEST")
    const complete = (await events(root)).find((event) => event.operation_type === "COMPLETE")
    assert.equal(complete.body.governance.exit_code, 0)
    assert.equal(complete.body.governance.candidate_sha, sha("b"))
    const state = (await (await createExecutionController({ dir: join(root, ".harness", "execution", "controller", "E1") })).snapshot()).state
    assert.equal(state.completed, true)
    const replay = await runExecutionController(root, { action: "complete", execution_id: "E1", session_id: "root" })
    assert.equal(replay.commit_status, "replayed")
    assert.equal(replay.governance.exit_code, 0)
  })
})

test("a failing closure gate cannot be recorded as a successful Epic close", async () => {
  await withRoot(async (root) => {
    await writeConfig(root, { epicClosureCommand: { program: "node", args: ["-e", CLOSURE_FAILURE] } })
    await completedExecution(root)
    await assert.rejects(
      runExecutionController(root, { action: "complete", execution_id: "E1", session_id: "root" }),
      (error) => error.code === "EPIC_CLOSURE_GATE_FAILED",
    )
    const state = (await (await createExecutionController({ dir: join(root, ".harness", "execution", "controller", "E1") })).snapshot()).state
    assert.equal(state.completed, false)
    assert.equal((await events(root)).some((event) => event.operation_type === "COMPLETE"), false)
  })
})

test("a configured closure gate without a canonical Epic identity fails closed", async () => {
  await withRoot(async (root) => {
    await writeConfig(root, { epicClosureCommand: { program: "node", args: ["-e", CLOSURE_STATUS] } })
    await completedExecution(root, { epicId: null })
    await assert.rejects(
      runExecutionController(root, { action: "complete", execution_id: "E1", session_id: "root" }),
      (error) => error.code === "EPIC_GATE_MISSING_EPIC_ID",
    )
  })
})

test("projects without the gate keep prior complete behavior", async () => {
  await withRoot(async (root) => {
    await completedExecution(root)
    const result = await runExecutionController(root, { action: "complete", execution_id: "E1", session_id: "root" })
    assert.equal(result.commit_status, "committed")
    assert.equal(result.governance, undefined)
    const state = (await (await createExecutionController({ dir: join(root, ".harness", "execution", "controller", "E1") })).snapshot()).state
    assert.equal(state.completed, true)
  })
})

test("re-approval preserves a stored epic_id for the same execution", async () => {
  await withRoot(async (root) => {
    await writeConfig(root, { epicActivationCommand: { program: "node", args: ["-e", CLOSURE_STATUS], require_candidate_sha: false } })
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "root", total_seconds: 100, epic_id: "EPIC-TEST" })
    const replay = await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "root", total_seconds: 100 })
    assert.equal(replay.commit_status, "replayed")
    const mandates = (await events(root)).filter((event) => event.operation_type === "MANDATE_APPROVE")
    assert.equal(mandates.length, 1)
    assert.equal(mandates[0].body.epic_id, "EPIC-TEST")
  })
})

test("activation gate runs on mandate approval and rejects a failing mandate", async () => {
  await withRoot(async (root) => {
    await writeConfig(root, { epicActivationCommand: { program: "node", args: ["-e", CLOSURE_STATUS], require_candidate_sha: false } })
    const ok = await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "root", total_seconds: 100, epic_id: "EPIC-TEST" })
    assert.equal(ok.commit_status, "committed")
    assert.equal(ok.governance.gate, "epic-activation")
    const mandate = (await events(root)).find((event) => event.operation_type === "MANDATE_APPROVE")
    assert.equal(mandate.body.epic_id, "EPIC-TEST")
    assert.equal(mandate.body.governance.epic_id, "EPIC-TEST")

    await writeConfig(root, { epicActivationCommand: { program: "node", args: ["-e", CLOSURE_FAILURE], require_candidate_sha: false } })
    await assert.rejects(
      runExecutionController(root, { action: "init", execution_id: "E2", session_id: "root", total_seconds: 100, epic_id: "EPIC-TEST" }),
      (error) => error.code === "EPIC_ACTIVATION_GATE_FAILED",
    )
    await assert.rejects(readFile(join(root, ".harness", "execution", "controller", "E2", "events.ndjson")), /ENOENT/)
  })
})

test("a closure gate approved with the mandate cannot be silently disabled later", async () => {
  await withRoot(async (root) => {
    await writeConfig(root, { epicClosureCommand: { program: "node", args: ["-e", CLOSURE_STATUS] } })
    await completedExecution(root, { closureRequired: true })
    // Simulate an agent removing/neutering the config after approval.
    await writeConfig(root, {})
    await assert.rejects(
      runExecutionController(root, { action: "complete", execution_id: "E1", session_id: "root" }),
      (error) => error.code === "EPIC_CLOSURE_GATE_DISABLED",
    )
  })
})

test("mandate approval pins a configured closure gate config hash", async () => {
  await withRoot(async (root) => {
    await writeConfig(root, {
      epicActivationCommand: { program: "node", args: ["-e", "process.exit(0)"], require_candidate_sha: false },
      epicClosureCommand: { program: "node", args: ["-e", "process.exit(0)"] },
    })
    const original = await readFile(join(root, "harness.config.json"))
    const pinned = createHash("sha256").update(original).digest("hex")
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "root", total_seconds: 100, epic_id: "EPIC-TEST" })
    const mandate = (await events(root)).find((event) => event.operation_type === "MANDATE_APPROVE")
    assert.equal(mandate.body.governance_closure_required, true)
    assert.equal(mandate.body.governance_config_sha256, pinned)
  })
})

test("a gate config rewritten after approval is rejected as drift", async () => {
  await withRoot(async (root) => {
    await writeConfig(root, { epicClosureCommand: { program: "node", args: ["-e", CLOSURE_STATUS] } })
    const original = await readFile(join(root, "harness.config.json"))
    const pinned = createHash("sha256").update(original).digest("hex")
    await completedExecution(root, { closureRequired: true, governanceConfigSha256: pinned })
    // Replace the approved gate with a no-op that always passes.
    await writeConfig(root, { epicClosureCommand: { program: "node", args: ["-e", "process.exit(0)"] } })
    await assert.rejects(
      runExecutionController(root, { action: "complete", execution_id: "E1", session_id: "root" }),
      (error) => error.code === "EPIC_GATE_CONFIG_DRIFT",
    )
  })
})

test("an unknown gate phase is rejected before command selection", async () => {
  await withRoot(async (root) => {
    const config = { path: join(root, "harness.config.json"), sha256: null, activation: null, closure: null }
    await assert.rejects(
      runProjectGovernanceGate({ projectRoot: root, phase: "bogus", epicId: "EPIC-X", config }),
      (error) => error.code === "EPIC_GATE_PHASE_INVALID",
    )
  })
})

test("epic_id is bound to the approved Epic artifact", async () => {
  await withRoot(async (root) => {
    await writeConfig(root, { epicActivationCommand: { program: "node", args: ["-e", "process.exit(0)"], require_candidate_sha: false } })
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: "epic-001", title: "Test Epic",
      content: 'test epic\n execution_mandate: {"max_wus":1,"total_seconds":100,"epic_id":"EPIC-A"}',
      status: "APPROVED", owner_confirmed: true, source_refs: ["https://example.com/epic"],
    })
    await assert.rejects(
      runExecutionController(root, { action: "approve_mandate", execution_id: "E1", session_id: "root", epic_artifact_id: "epic-001", epic_id: "EPIC-B" }),
      /EPIC_ID_MISMATCH/,
    )
    const ok = await runExecutionController(root, { action: "approve_mandate", execution_id: "E1", session_id: "root", epic_artifact_id: "epic-001" })
    assert.equal(ok.commit_status, "committed")
    assert.equal((await events(root)).find((event) => event.operation_type === "MANDATE_APPROVE").body.epic_id, "EPIC-A")
  })
})

test("placeholder typos and timeouts fail closed", async () => {
  await withRoot(async (root) => {
    await writeConfig(root, { epicClosureCommand: { program: "node", args: ["-e", "process.exit(0)", "{Epic_Id}"] } })
    const bad = await loadProjectGovernance(root)
    await assert.rejects(
      runProjectGovernanceGate({ projectRoot: root, phase: "closure", epicId: "EPIC-TEST", state: { merge: { merge_commit_sha: sha("b") } }, config: bad }),
      (error) => error.code === "EPIC_GATE_UNKNOWN_PLACEHOLDER",
    )
    await writeConfig(root, { epicClosureCommand: { program: "node", args: ["-e", "setTimeout(() => {}, 5000)"], timeout_ms: 50 } })
    const slow = await loadProjectGovernance(root)
    await assert.rejects(
      runProjectGovernanceGate({ projectRoot: root, phase: "closure", epicId: "EPIC-TEST", state: { merge: { merge_commit_sha: sha("b") } }, config: slow }),
      (error) => error.code === "EPIC_CLOSURE_GATE_FAILED" && error.gate_receipt.timed_out === true,
    )
  })
})

test("MANDATE_AMEND fills an absent epic_id once and never changes it", () => {
  const event = (state, type, body) => ({
    sequence: state.revision + 1, event_id: `e${state.revision + 1}`,
    operation_id: `o${state.revision + 1}:${type}`, operation_type: type,
    operation_hash: "h", body, previous_revision: state.revision,
    next_revision: state.revision + 1, fencing_token: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
  })
  let state = initialState()
  state = applyEvent(state, event(state, "MANDATE_APPROVE", {
    mandate_id: "M", max_wus: 1, total_seconds: 100, authority_kind: "OWNER_APPROVED_EPIC",
    source_artifact_id: "a", source_record_key: "r", source_hash: "h",
  }))
  const amend = (epicId) => event(state, "MANDATE_AMEND", {
    mandate_id: "M", max_wus: 1, total_seconds: 100,
    expected_merge_policy: "none", expected_required_ci_checks: [],
    merge_policy: "none", required_ci_checks: [],
    source_artifact_id: "a", source_record_key: "r", source_hash: "h",
    epic_id: epicId,
  })
  state = applyEvent(state, amend("EPIC-A"))
  assert.equal(state.mandate.epic_id, "EPIC-A")
  assert.throws(() => applyEvent(state, amend("EPIC-B")), /cannot change an existing epic_id/)
})
