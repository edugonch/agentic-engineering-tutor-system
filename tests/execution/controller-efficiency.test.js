import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateControllerPreflight } from "../../src/execution/controller-preflight.js"
import { presentControllerResponse } from "../../src/execution/controller-response.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"

test("E05-06-E: wrong decision_artifact_id fails before reading or mutating controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-preflight-"))
  try {
    await assert.rejects(
      runExecutionController(root, {
        action: "correct_verification_contract", execution_id: "E05-06-E",
        decision_artifact_id: "verification-fix-v3",
      }),
      /requires wu_artifact_id.*decision_artifact_id is not accepted/,
    )
    await assert.rejects(stat(join(root, ".harness", "execution", "controller", "E05-06-E")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("E05-06-E: correction preflight rejects malformed hash, missing reason and malformed mapping", () => {
  const input = { action: "correct_verification_contract", wu_artifact_id: "WU-078",
    expected_contract_hash: "a".repeat(64), reason: "Fix frozen setup" }
  assert.doesNotThrow(() => validateControllerPreflight(input))
  assert.throws(() => validateControllerPreflight({ ...input, expected_contract_hash: "invalid" }), /requires expected_contract_hash/)
  assert.throws(() => validateControllerPreflight({ ...input, reason: " " }), /requires reason/)
  assert.throws(() => validateControllerPreflight({ ...input, check_mapping: { old: [] } }), /check_mapping must map/)
  assert.doesNotThrow(() => validateControllerPreflight({ ...input, check_mapping: { old: ["new"] } }))
})

test("controller presentation trims large histories but preserves recovery, identity and receipts", () => {
  const long = "evidence".repeat(900)
  const full = {
    action: "record_finish", commit_status: "committed", execution_id: "E05-06-E",
    revision: 856, next_action: { kind: "CONTINUE", action: "recover" },
    fencing_token: 42, blocker: { class: "BLOCKED_TOOLING", at_revision: 855 },
    budget: { total_seconds: 1000, used_seconds: 200, available_seconds: 800 },
    mandate: { mandate_id: "m", authority_kind: "OWNER_APPROVED_EPIC", source_artifact_id: "epic",
      merge_policy: "PR", required_ci_checks: ["test"], wu_sequence: ["WU-078"] },
    wu: { wu_id: "WU-078", completed: false, origin: "DERIVED",
      contract: { contract_hash: "c".repeat(64), verification_contract_hash: "d".repeat(64),
        source_content: long } },
    dispatches: Array.from({ length: 20 }, (_, i) => ({ dispatch_id: `dispatch-${i}`, status: "finished", result: long })),
    candidates: { cand: { wu_id: "WU-078", tree_hash: "f".repeat(64), manifest: long } },
    reviews: { cand: { verdict: "CHANGES_REQUIRED", verification_evidence_ids: ["receipt"], verbose: long } },
    authority_resolutions: { x: long }, wu_budget_amendments: { y: long },
    pr_bindings: { z: long }, merges: { k: long }, ci_evidence: { one: long },
    checkpoint: { note: long },
  }
  const receipt = presentControllerResponse(full, { dispatch_id: "dispatch-1", candidate_id: "cand" })
  assert.equal(receipt.response_detail, "compact")
  assert.equal(receipt.revision, 856)
  assert.equal(receipt.fencing_token, 42)
  assert.equal(receipt.blocker.class, "BLOCKED_TOOLING")
  assert.equal(receipt.budget.available_seconds, 800)
  assert.equal(receipt.wu.wu_id, "WU-078")
  assert.equal(receipt.dispatch_count, 20)
  assert.equal(receipt.dispatches.length, 1)
  assert.equal(receipt.candidate_count, 1)
  assert.equal(receipt.review_count, 1)
  assert.ok(JSON.stringify(receipt).length < JSON.stringify(full).length * 0.25)
  assert.deepEqual(presentControllerResponse(full, { response_detail: "full" }), full)
  assert.deepEqual(presentControllerResponse({ ...full, action: "status" }), { ...full, action: "status" })
  assert.throws(() => presentControllerResponse(full, { response_detail: "unknown" }), /response_detail/)
})
