import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initialState, applyEvent, canStartMerge } from "../../src/execution/state.js"
import { sha256 } from "../../src/execution/serialize.js"
import { batchHash } from "../../src/execution/wu-batch.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { createExecutionController } from "../../src/execution/execution.js"

const ids = ["WU-27", "WU-28", "WU-29"]
const source = id => [
  "---", "status: DRAFT", "---", "# " + id,
  "Salida comprobable: test for " + id,
  "Expected write scope: scheduling/",
].join("\n")
const member = id => ({
  wu_id: id, source_record_key: "record-" + id,
  source_hash: sha256(source(id)), source_content: source(id),
})
const contract = {
  source_record_key: "record-WU-27", source_hash: sha256(source(ids[0])),
  source_content: source(ids[0]), contract_hash: "a".repeat(64),
  verification_contract_hash: "b".repeat(64), normalization_required: false,
  process_obligations: [],
}
const next = (state, operation_type, body) => applyEvent(state, {
  operation_type, body, next_revision: state.revision + 1,
})

function setup() {
  const s = initialState()
  s.execution_id = "batch-e:exec"
  s.mandate = {
    mandate_id: "mandate", authority_kind: "OWNER_APPROVED_EPIC",
    wu_sequence: [...ids], max_wus: ids.length, merge_policy: "governed_auto",
    required_ci_checks: [],
  }
  s.budget.total_seconds = 3600
  s.wu = { wu_id: ids[0], mandate_id: "mandate", completed: false, contract }
  s.activated_wu_ids = [ids[0]]
  return s
}
const proposal = () => {
  const body = {
    wu_ids: [...ids], members: ids.map(member),
    lead_contract_hash: contract.contract_hash,
    owner_confirmed: true,
    authorization_ref: "owner-instruction:2026-11-05:batch-10",
  }
  return { ...body, batch_hash: batchHash(body) }
}

test("grouped WU delivery keeps one candidate/review/merge and closes each member atomically", () => {
  const original = setup()
  const grouped = next(original, "WU_BATCH_CONFIGURE", proposal())
  assert.equal(original.wu.batch, undefined)
  assert.deepEqual(grouped.wu.batch.wu_ids, ids)
  assert.equal(grouped.activated_wu_ids.length, 1, "batch should not advance sequence before accepted merge")
  const candidate_id = "cand-frozen"
  const manifest_hash = "d".repeat(64)
  const tree_hash = "e".repeat(64)
  const frozen = next(grouped, "FREEZE_CANDIDATE", {
    candidate_id, wu_id: ids[0], manifest_hash, tree_hash,
    batch_hash: grouped.wu.batch.batch_hash,
    verification_contract_hash: contract.verification_contract_hash,
    required_check_ids: ["test"],
  })
  const bad = {
    candidate_id, verdict: "PASS", batch_hash: grouped.wu.batch.batch_hash,
    batch_coverage_wu_ids: ids.slice(0, 2),
    candidate_hashes: { manifest_hash, tree_hash },
    verification_contract_hash: contract.verification_contract_hash,
    verified_check_ids: ["test"], verification_evidence_ids: ["verify-1"],
  }
  assert.throws(() => next(frozen, "RECORD_REVIEW", bad), /cover every ordered member/)
  const reviewed = next(frozen, "RECORD_REVIEW",
    { ...bad, batch_coverage_wu_ids: ids })
  reviewed.pr_binding = {
    candidate_id, repository: "owner/repo", pr_number: 123,
    head_sha: "reviewed-head", base_sha: "base", base_branch: "main",
  }
  assert.equal(canStartMerge(reviewed).allowed, true)
  reviewed.merge = { status: "VERIFIED", candidate_id, merge_commit_sha: "merged-head" }
  assert.throws(() => next(reviewed, "WU_COMPLETE", { candidate_id }), /batch identity/)
  const completed = next(reviewed, "WU_COMPLETE",
    { candidate_id, batch_hash: grouped.wu.batch.batch_hash })
  assert.equal(completed.wu.completed, true)
  assert.deepEqual(completed.activated_wu_ids, ids)
  for (const id of ids) {
    assert.equal(completed.completed_wus[id].candidate_id, candidate_id)
    assert.equal(completed.completed_wus[id].batch_hash, grouped.wu.batch.batch_hash)
    assert.equal(completed.completed_wus[id].source_hash, sha256(source(id)))
    assert.equal(completed.completed_wus[id].merge_commit_sha, "merged-head")
  }
  const epic = next(completed, "COMPLETE", { result: "done" })
  assert.equal(epic.completed, true)
})

test("grouping requires explicit owner instruction, contiguous frozen membership and untouched lead WU", () => {
  const base = setup()
  assert.throws(() => next(base, "WU_BATCH_CONFIGURE", {
    ...proposal(), owner_confirmed: false,
  }), /owner confirmation/)
  assert.throws(() => next(base, "WU_BATCH_CONFIGURE", {
    ...proposal(), wu_ids: [ids[0], ids[2], ids[1]],
  }), /consecutive frozen/)
  assert.throws(() => next(base, "WU_BATCH_CONFIGURE", {
    ...proposal(), wu_ids: [ids[0], ids[1], ids[1]],
  }), /unique ordered/)
  assert.throws(() => next(base, "WU_BATCH_CONFIGURE", {
    ...proposal(), members: [member(ids[0]), { ...member(ids[1]), source_hash: "0".repeat(64) }, member(ids[2])],
  }), /hash-bound source/)
  assert.throws(() => next(base, "WU_BATCH_CONFIGURE", {
    ...proposal(), members: [member(ids[0]), { ...member(ids[1]), source_content: "# No acceptance" }, member(ids[2])],
  }), /hash-bound source/)
  const worked = setup()
  worked.candidates.existing = { wu_id: ids[0] }
  assert.throws(() => next(worked, "WU_BATCH_CONFIGURE", proposal()), /no started work/)
  assert.throws(() => next(next(base, "WU_BATCH_CONFIGURE", proposal()), "WU_BATCH_CONFIGURE", proposal()), /already frozen/)
})

test("frozen candidate must match batch provenance and explicit review coverage", () => {
  const grouped = next(setup(), "WU_BATCH_CONFIGURE", proposal())
  const freeze = {
    candidate_id: "cand-A", wu_id: ids[0], manifest_hash: "a".repeat(64),
    tree_hash: "b".repeat(64), required_check_ids: [],
  }
  assert.throws(() => next(grouped, "FREEZE_CANDIDATE", freeze), /exact frozen WU batch/)
  assert.throws(() => next(setup(), "FREEZE_CANDIDATE",
    { ...freeze, batch_hash: grouped.wu.batch.batch_hash }), /unexpected batch hash/)
})

test("normal single-WU completion and admission remain unchanged", () => {
  let state = setup()
  const candidate_id = "single"
  state = next(state, "FREEZE_CANDIDATE", {
    candidate_id, wu_id: ids[0], manifest_hash: "a".repeat(64), tree_hash: "b".repeat(64),
  })
  state = next(state, "RECORD_REVIEW", {
    candidate_id, verdict: "PASS",
    candidate_hashes: { manifest_hash: "a".repeat(64), tree_hash: "b".repeat(64) },
    verification_evidence_ids: ["receipt"], verified_check_ids: [],
  })
  state.merge = { candidate_id, status: "VERIFIED", merge_commit_sha: "merged" }
  state = next(state, "WU_COMPLETE", { candidate_id })
  assert.deepEqual(state.activated_wu_ids, [ids[0]])
  assert.equal(state.completed_wus[ids[0]].candidate_id, candidate_id)
})

test("public controller accepts explicit grouping of already indexed DRAFT WUs", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-batch-integration-"))
  try {
    const epicId = "epic-batch"
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: epicId, owner_confirmed: true,
      status: "APPROVED", title: "Batch epic",
      source_refs: ["https://example.com/batch-authority"],
      content: 'execution_mandate: ' + JSON.stringify({
        max_wus: ids.length, total_seconds: 3600, merge_policy: "governed_auto",
        required_ci_checks: [], wu_sequence: ids,
      }),
    })
    const verification_contract = {
      commands: [{ id: "test", program: "node", args: ["-e", "process.exit(0)"] }],
      environment: { network_policy: "UNRESTRICTED" },
    }
    for (const [index, id] of ids.entries()) {
      await recordKnowledgeArtifact(root, {
        artifact_type: "work-unit", artifact_id: id, title: id,
        owner_confirmed: true, status: index === 0 ? "PROPOSED" : "DRAFT",
        parent_refs: [epicId],
        content: [
          "Salida comprobable: test DB", "Expected write scope: scheduling/",
          ...(index === 0 ? [
            "Active-time limit: 120 seconds",
            "execution_contract: " + JSON.stringify({
              active_seconds: 120, verification_contract, process_obligations: [],
            }),
          ] : []),
        ].join("\n"),
      })
    }
    const invoke = args => runExecutionController(root, { execution_id: "batch-test",
      session_id: "owner-session", ...args })
    await invoke({ action: "approve_mandate", epic_artifact_id: epicId })
    await invoke({ action: "activate_wu", wu_id: ids[0], mandate_id: "batch-test-MANDATE-001" })
    const state = await invoke({ action: "status" })
    const configured = await invoke({ action: "configure_wu_batch",
      expected_revision: state.revision,
      owner_confirmed: true, authorization_ref: "owner-instruction:batch",
      wu_ids: ids,
    })
    assert.equal(configured.commit_status, "committed")
    assert.deepEqual(configured.wu.batch.wu_ids, ids)
    assert.ok(configured.wu.batch.members.every(x => x.source_hash && x.source_record_key))
    const reread = await invoke({ action: "status" })
    assert.equal(reread.wu.batch.batch_hash, configured.batch_hash)
    const controller = await createExecutionController({
      dir: join(root, ".harness", "execution", "controller", "batch-test"),
    })
    assert.equal((await controller.snapshot()).state.activated_wu_ids.length, 1)
    const replay = await invoke({ action: "configure_wu_batch",
      expected_revision: state.revision, owner_confirmed: true, authorization_ref: "owner-instruction:batch",
      wu_ids: ids })
    assert.equal(replay.commit_status, "already_configured")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
