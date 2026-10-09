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
    source_refs: ["https://example.com/approval"], content: 'execution_mandate: {"max_wus":1,"total_seconds":200,"merge_policy":"governed_auto","required_ci_checks":["verify"]}' })
  await seedWuContract(root, "WU-01", "epic-001", 200)
  await run("approve_mandate", { epic_artifact_id: "epic-001" })
  await run("activate_wu", { wu_id: "WU-01", mandate_id: "E-MANDATE-001" })
  const controller = await createExecutionController({ dir: join(root, ".harness/execution/controller/E") })
  const old = (await controller.snapshot()).state.wu.contract
  const typed = { active_seconds: old.active_seconds, process_obligations: old.process_obligations,
    verification_contract: { ...old.verification_contract, commands: [{ id: "new-check", program: "node", args: ["--version"] }] } }
  const content = "# Additional normalization explanation\n" + old.source_content.replace(/^execution_contract: .*$/m, 'execution_contract: '+JSON.stringify(typed))
  const input = { wu_artifact_id: "WU-01-CORRECTED", expected_contract_hash: old.contract_hash, reason: "Correct command" }
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
  // Exercise the next steps, not just acceptance of the correction event.
  const { freezeCandidate } = await import("../../src/execution/candidate.js")
  const { createCandidateRegistry } = await import("../../src/execution/candidate-registry.js")
  const { runCandidateVerification } = await import("../../src/execution/verification.js")
  const { createVerificationReceipt, writeVerificationReceipt } = await import("../../src/execution/verification-results.js")
  const { candidateGitTree } = await import("../../src/execution/git-tree.js")
  const { runMergeCandidate } = await import("../../src/execution/merge.js")
  await run("block", { class: "BLOCKED_TOOLING", reason: "Original runner correction pending" })
  await run("clear_blocker", { resolution: "Correction accepted; use effective checks" })
  const effective = (await controller.snapshot()).state.wu.contract.verification_contract
  const frozen = await freezeCandidate(root, { base: { kind: "snapshot", files: [] }, verification_contract: effective })
  await createCandidateRegistry({ dir: join(root, ".harness/execution") }).store(frozen)
  await run("record_candidate", { candidate_id: frozen.candidate_id })
  const result = await runCandidateVerification(frozen, "new-check")
  assert.equal(result.status, "PASS")
  const receipt = createVerificationReceipt(result)
  await writeVerificationReceipt(join(root, ".harness/execution/verification-results"), receipt)
  await run("record_review", { candidate_id: frozen.candidate_id, verdict: "PASS", reviewer: "independent-test-reviewer", verification_evidence_ids: [receipt.evidence_id] })
  await run("bind_pr", { candidate_id: frozen.candidate_id, repository: "test/repo", pr_number: 165, head_sha: "head", base_sha: "base", base_branch: "main" })
  await run("record_ci", { candidate_id: frozen.candidate_id, head_sha: "head", check_identity: "verify", conclusion: "SUCCESS" })
  let merged = false
  const adapter = {
    getCommitTree: async () => candidateGitTree(frozen),
    getPullRequest: async () => ({ state: merged ? "closed" : "open", merged, head_sha: "head", base_sha: "base", base_branch: "main", merge_commit_sha: merged ? "merge" : null }),
    getChecks: async () => [{ name: "verify", conclusion: "SUCCESS" }],
    merge: async () => { merged = true; return { merged: true, merge_commit_sha: "merge" } },
  }
  await runMergeCandidate(root, { candidate_id: frozen.candidate_id, adapter, session_id: "root" })
  await run("complete_wu", { candidate_id: frozen.candidate_id })
  assert.equal((await controller.snapshot()).state.wu.completed, true)
  assert.equal((await run("verify")).passed, true)
})

test("verification-only correction preserves original source despite proposal prose drift and derives split mapping", async () => {
  const { deriveVerificationCorrection, correctionCheckMapping } = await import("../../src/execution/contract-correction.js")
  const { state, body } = fixture()
  const proposal = structuredClone(body.contract)
  proposal.source_content = '# New normalization title\n' + proposal.source_content
  const { stableHash } = await import("../../src/execution/serialize.js")
  const { contract_hash: ignored, ...unsigned } = proposal
  proposal.contract_hash = stableHash(unsigned)
  const old = state.wu.contract
  const next = deriveVerificationCorrection(old, proposal)
  const mapping = correctionCheckMapping(old.verification_contract, next.verification_contract)
  const corrected = applyEvent(state, { operation_type: "WU_CONTRACT_CORRECT", body: {
    ...body, contract: next, check_mapping: mapping, mode: "verification_only" } })
  assert.equal(corrected.wu.contract.source_content, old.source_content)
  assert.equal(corrected.wu.contract.source_hash, old.source_hash)
  assert.deepEqual(corrected.wu.contract.verification_contract, proposal.verification_contract)
  assert.equal(corrected.wu.contract.correction_source.source_content, proposal.source_content)
  assert.deepEqual(mapping, { types: ["types"], tests: ["commerce-tests", "api-tests", "crm-tests"] })
  assert.deepEqual(correctionCheckMapping({ ...old.verification_contract, setup: [{ id: "install" }] }, next.verification_contract,
    { ...mapping, install: ["install"] }), mapping)
})

test('delegated additive checks retain existing gates and cannot substitute echo/pass or widen capabilities', async () => {
  const { deriveVerificationCorrection, correctionCheckMapping } = await import('../../src/execution/contract-correction.js')
  const { stableHash } = await import('../../src/execution/serialize.js')
  const { state } = fixture()
  const old = state.wu.contract
  state.process_policy = { source_hash: 'f'.repeat(64), policy: { technical_verification: true } }
  for (const variation of ['add', 'replace', 'capability', 'environment', 'setup', 'wrong-policy']) {
    const nextVerification = structuredClone(old.verification_contract)
    nextVerification.commands.push({ id: 'extra-regression', program: 'node', args: ['--test', 'regression.test.js'] })
    if (variation === 'replace') nextVerification.commands[0].args = ['-e', 'process.exit(0)']
    if (variation === 'capability') nextVerification.capabilities = ['NETWORK']
    if (variation === 'environment') nextVerification.environment = { network_policy: 'NETWORK_FORBIDDEN' }
    if (variation === 'setup') nextVerification.setup = [{ id: 'new-install', program: 'npm', args: ['install'] }]
    const { contract_hash: ignored, ...unsigned } = compileWuContract('WU1', { content: 'execution_contract: '+JSON.stringify({ active_seconds: 2400, verification_contract: nextVerification, process_obligations: old.process_obligations }), source_record_key: 'proposal', source_hash: 'a'.repeat(64), source_authority: 'DELEGATED_TECHNICAL' })
    const source = { ...unsigned, policy_source_hash: variation === 'wrong-policy' ? 'e'.repeat(64) : state.process_policy.source_hash }
    const proposal = { ...source, contract_hash: stableHash(source) }
    const contract = deriveVerificationCorrection(old, proposal)
    const body = { mode: 'verification_only', contract, expected_contract_hash: old.contract_hash, reason: 'Add discovered coverage', check_mapping: correctionCheckMapping(old.verification_contract, contract.verification_contract) }
    if (variation === 'add') {
      const next = applyEvent(state, { operation_type: 'WU_CONTRACT_CORRECT', body })
      assert.equal(next.wu.contract.source_content, old.source_content)
      assert.equal(next.wu.contract.verification_contract.commands.length, old.verification_contract.commands.length + 1)
      assert.equal(next.candidates.old.superseded_by_contract, contract.contract_hash)
    } else assert.throws(() => applyEvent(state, { operation_type: 'WU_CONTRACT_CORRECT', body }), undefined, variation)
  }
})
