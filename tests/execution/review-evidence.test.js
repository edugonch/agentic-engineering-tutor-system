import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareReviewEvidence } from "../../src/execution/review-evidence.js"
import { createVerificationReceipt, writeVerificationReceipt } from "../../src/execution/verification-results.js"

const makeState = () => ({ revision: 6, wu: { wu_id: "WU-01", contract: { verification_contract_hash: "contract" } },
  candidates: { "cand-1": { wu_id: "WU-01", manifest_hash: "manifest", tree_hash: "tree",
    wu_contract_hash: "wu-hash", verification_contract_hash: "contract",
    required_check_ids: ["lint", "test"] } } })
const receipt = (candidate_id, check_id, status = "PASS", contract = "contract") =>
  createVerificationReceipt({ candidate_id, check_id, status,
    verification_contract_hash: contract, exitCode: status === "PASS" ? 0 : 1,
    fingerprint: { node: "v22", platform: "linux", timestamp: "2026-10-21T00:00:00Z" } })
const run = (root, state = makeState(), extra = {}) => prepareReviewEvidence(root, state, {
  execution_id: "execution-1", wu_id: "WU-01", candidate_id: "cand-1", ...extra })

test("returns real immutable PASS/FAIL IDs, not invented ones; no writes or verification", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-review-packet-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, ".harness", "execution", "verification-results")
  const pass = receipt("cand-1", "lint")
  const fail = receipt("cand-1", "test", "FAIL")
  await writeVerificationReceipt(path, pass)
  await writeVerificationReceipt(path, fail)
  const before = await readdir(path)
  const result = await run(root)
  assert.equal(result.status, "CHECKS_WITHOUT_PASS")
  assert.deepEqual(result.pass_receipts.map(x => x.evidence_id), [pass.evidence_id])
  assert.deepEqual(result.fail_receipts.map(x => x.evidence_id), [fail.evidence_id])
  assert.deepEqual(result.missing_check_ids, ["test"])
  assert.equal(result.ready_for_review, false)
  assert.equal(result.evidence_freshness, "UNKNOWN_REQUIRES_POLICY")
  assert.deepEqual(await readdir(path), before)
  await assert.rejects(access(join(root, ".harness", "execution", "controller", "execution-1", "lease.json")))
})

test("exact PASS coverage is still marked freshness UNKNOWN pending applicable policy", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-review-pass-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, ".harness", "execution", "verification-results")
  const a = receipt("cand-1", "lint"), b = receipt("cand-1", "test")
  await writeVerificationReceipt(dir, a)
  await writeVerificationReceipt(dir, b)
  const result = await run(root)
  assert.equal(result.status, "EXACT_PASS_RECEIPTS_FOUND_FRESHNESS_UNKNOWN")
  assert.equal(result.coverage_complete_as_historical_evidence, true)
  assert.equal(result.ready_for_review, false)
  assert.deepEqual(result.exact_pass_evidence_ids.sort(), [a.evidence_id, b.evidence_id].sort())
})

test("receipt from another candidate is never suggested; explicit foreign ID is rejected", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-review-foreign-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, ".harness", "execution", "verification-results")
  const foreign = receipt("cand-old", "lint")
  await writeVerificationReceipt(dir, foreign)
  const result = await run(root, makeState(), { verification_evidence_ids: [foreign.evidence_id] })
  assert.equal(result.rejected_receipts[0].reason, "OTHER_CANDIDATE")
  assert.deepEqual(result.exact_pass_evidence_ids, [])
})

test("unknown receipt IDs and unexpected checks/contracts are never accepted", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-review-invalid-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, ".harness", "execution", "verification-results")
  await writeVerificationReceipt(dir, receipt("cand-1", "other"))
  await writeVerificationReceipt(dir, receipt("cand-1", "lint", "PASS", "different-contract"))
  const result = await run(root, makeState(), { verification_evidence_ids: ["verify-" + "0".repeat(64)] })
  assert.equal(result.status, "INVALID_EVIDENCE_FOUND")
  assert.ok(result.rejected_receipts.some(e => e.reason === "NOT_FOUND"))
  assert.ok(result.rejected_receipts.some(e => e.reason === "OTHER_CONTRACT"))
  assert.ok(result.rejected_receipts.some(e => e.reason === "UNDECLARED_CHECK"))
})

test("tampered receipts produce an invalid-evidence packet without suppressing diagnostics", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-review-tamper-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, ".harness", "execution", "verification-results")
  const good = receipt("cand-1", "lint")
  await writeVerificationReceipt(dir, good)
  const path = join(dir, good.evidence_id + ".json")
  const data = JSON.parse(await readFile(path, "utf8"))
  data.status = "FAIL"
  await writeFile(path, JSON.stringify(data))
  const result = await run(root)
  assert.equal(result.status, "INVALID_EVIDENCE_FOUND")
  assert.equal(result.rejected_receipts[0].reason, "RECEIPT_TAMPERED")
})

test("candidate/WU/contract mismatch fail closed without filesystem side effects", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-review-mismatch-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal((await run(root, makeState(), { candidate_id: "missing" })).status, "CANDIDATE_MISMATCH")
  const state = makeState()
  state.wu.contract.verification_contract_hash = "updated"
  assert.equal((await run(root, state)).status, "STALE_OR_UNBOUND_CANDIDATE")
  await assert.rejects(access(join(root, ".harness")))
})

test("public controller action does not initialize missing execution or create lease", async t => {
  const { runExecutionController } = await import("../../src/execution/controller-tool.js")
  const root = await mkdtemp(join(tmpdir(), "harness-review-action-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const response = await runExecutionController(root, {
    action: "prepare_review_evidence", execution_id: "absent", wu_id: "WU-01",
    candidate_id: "cand-1" })
  assert.equal(response.status, "EXECUTION_NOT_FOUND")
  await assert.rejects(access(join(root, ".harness")))
})
