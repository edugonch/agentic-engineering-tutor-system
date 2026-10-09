import test from "node:test"
import assert from "node:assert/strict"
import { initialState, applyEvent, canStartMerge, canVerifyExternalMerge } from "../../src/execution/state.js"
import { compileWuContract } from "../../src/execution/wu-contract.js"

function fixture() {
  const base = { active_seconds: 2400, process_obligations: ["fresh review"], verification_contract: {
    commands: [{ id: "tests", program: "npx", args: ["vitest", "run"] }, { id: "types", program: "npm", args: ["run", "typecheck"] }] } }
  const compile = (typed, extra = "") => compileWuContract("WU1", { content: 'Scope and all acceptance criteria.\nActive-time limit: 40 minutes\nexecution_contract: '+JSON.stringify(typed)+extra,
    source_record_key: "approved", source_hash: "a".repeat(64), source_authority: "APPROVED" })
  const old = compile(base), typed = structuredClone(base)
  typed.verification_contract.commands.splice(0, 1, ...["commerce", "api", "crm"].map(w => ({ id: `${w}-tests`, program: "npm", args: ["run", "test", "-w", w] })))
  const corrected = compile(typed, "\nCorrection: retain workspace configurations.")
  const state = { ...initialState(), wu: { wu_id: "WU1", contract: old },
    budget: { ...initialState().budget, total_seconds: 86400, used_seconds: 14000 },
    candidates: { old: { wu_id: "WU1" } }, reviews: { old: { verdict: "PASS" } },
    ci_evidence: { old: { verify: { conclusion: "SUCCESS" } } },
    pr_binding: { candidate_id: "old" }, pr_bindings: { old: { candidate_id: "old" } },
    blocker: { class: "BLOCKED_TOOLING" } }
  const body = { contract: corrected, expected_contract_hash: old.contract_hash, reason: "Restore declared workspace test configuration",
    check_mapping: { tests: ["commerce-tests", "api-tests", "crm-tests"], types: ["types"] } }
  const apply = (s = state, b = body) => applyEvent(s, { operation_type: "WU_CONTRACT_CORRECT", body: b })
  return { state, body, apply, compile, typed }
}

test("explicit contract correction preserves accounting and history, supersedes old acceptance and requires refreeze", () => {
  const { state, body, apply } = fixture()
  assert.throws(() => applyEvent(state, { operation_type: "WU_CONTRACT_BIND", body: { contract: body.contract } }), /cannot be silently replaced/)
  const next = apply()
  assert.deepEqual(next.budget, state.budget)
  assert.deepEqual(next.blocker, state.blocker)
  assert.deepEqual(next.reviews, state.reviews)
  assert.deepEqual(next.ci_evidence, state.ci_evidence)
  assert.deepEqual(next.pr_bindings, state.pr_bindings)
  assert.equal(next.pr_binding, null)
  assert.equal(next.candidates.old.superseded_by_contract, body.contract.contract_hash)
  assert.deepEqual(next.contract_corrections[0].previous_contract, state.wu.contract)
  for (const operation_type of ["RECORD_REVIEW", "BIND_PR", "RECORD_CI"]) {
    assert.throws(() => applyEvent(next, { operation_type, body: { candidate_id: "old" } }), /superseded/)
  }
  next.blocker = null
  assert.throws(() => applyEvent(next, { operation_type: "WU_COMPLETE", body: { candidate_id: "old" } }), /superseded/)
  next.pr_binding = state.pr_binding
  assert.equal(canStartMerge(next).allowed, false)
  assert.equal(canVerifyExternalMerge(next).allowed, false)
})

for (const kind of ["stale", "scope", "budget", "process", "mapping", "phase", "dispatch", "merge", "permission", "approval"]) {
  test(`contract correction rejects ${kind}`, () => {
    const { state, body, apply, typed, compile } = fixture()
    if (kind === "stale") body.expected_contract_hash = "b".repeat(64)
    if (kind === "scope") { body.contract = compile(typed); body.contract.source_content = "changed scope" }
    if (kind === "budget") { typed.active_seconds = 2500; body.contract = { ...body.contract, active_seconds: 2500 } }
    if (kind === "process") { typed.process_obligations = []; body.contract = compile(typed) }
    if (kind === "mapping") delete body.check_mapping.tests
    if (kind === "phase") state.budget.active_phase = "ACTIVE"
    if (kind === "dispatch") state.dispatches.child = { status: "launched" }
    if (kind === "merge") state.merge = { status: "STARTED" }
    if (kind === "permission") state.blocker.class = "BLOCKED_PERMISSION"
    if (kind === "approval") body.contract.source_authority = "UNKNOWN"
    assert.throws(() => apply(state, body))
  })
}

test("controller correction loads approved artifact, replays idempotently and verifies durable history", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { recordKnowledgeArtifact } = await import("../../src/project-knowledge.js")
  const { seedWuContract } = await import("./wu-fixture.js")
  const { runExecutionController } = await import("../../src/execution/controller-tool.js")
  const { createExecutionController } = await import("../../src/execution/execution.js")
  const root = await mkdtemp(join(tmpdir(), "contract-correct-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = (action, extra = {}) => runExecutionController(root, { action, execution_id: "E", session_id: "root", ...extra })
  await recordKnowledgeArtifact(root, { artifact_type: "epic", artifact_id: "epic-001", title: "Epic", status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.com/approval"], content: 'execution_mandate: {"max_wus":1,"total_seconds":200}' })
  await seedWuContract(root, "WU-01", "epic-001", 200)
  await run("approve_mandate", { epic_artifact_id: "epic-001" })
  await run("activate_wu", { wu_id: "WU-01", mandate_id: "E-MANDATE-001" })
  const controller = await createExecutionController({ dir: join(root, ".harness/execution/controller/E") })
  const old = (await controller.snapshot()).state.wu.contract
  const typed = { active_seconds: old.active_seconds, process_obligations: old.process_obligations,
    verification_contract: { ...old.verification_contract, commands: [{ id: "new-check", program: "node", args: ["--version"] }] } }
  const content = old.source_content.replace(/^execution_contract: .*$/m, 'execution_contract: '+JSON.stringify(typed))
  const input = { wu_artifact_id: "WU-01-CORRECTED", expected_contract_hash: old.contract_hash, reason: "Correct command", check_mapping: { "check-1": ["new-check"] } }
  await recordKnowledgeArtifact(root, { artifact_type: "work-unit", artifact_id: "WU-01-CORRECTED", title: "Corrected", status: "PROPOSED", owner_confirmed: true, parent_refs: ["epic-001"], content })
  await assert.rejects(run("correct_verification_contract", input), /APPROVED/)
  await recordKnowledgeArtifact(root, { artifact_type: "work-unit", artifact_id: "WU-01-APPROVED", title: "Corrected", status: "APPROVED", owner_confirmed: true, parent_refs: ["epic-001"], content })
  input.wu_artifact_id = "WU-01-APPROVED"
  await run("correct_verification_contract", input)
  const beforeReplay = await controller.snapshot()
  assert.equal((await run("correct_verification_contract", input)).commit_status, "replayed")
  const afterReplay = await controller.snapshot()
  assert.deepEqual(afterReplay.state, beforeReplay.state)
  assert.deepEqual(afterReplay.events, beforeReplay.events)
  assert.equal((await run("verify")).passed, true)
})
