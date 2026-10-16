import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { verificationContractHash } from "../../src/execution/verification-contract.js"
import { treeHash } from "../../src/execution/candidate.js"
import { createVerificationReceipt, writeVerificationReceipt } from "../../src/execution/verification-results.js"
import { retryBlockedFrozenVerification } from "../../src/execution/setup-timeout-recovery.js"
import { recoveryAction } from "../../src/execution/progress.js"

async function fixture(t, { blockClass = "BLOCKED_TOOLING", reason = "Frozen npm ci setup verification timed out after 120 s", receiptMode = "timeout", actualCheck = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-retry-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  const c = await createExecutionController({ dir: join(root, "controller") })
  const receiptsDir = join(root, "receipts")
  const contract = { source_wu_id: "WU4",
    setup: [{ id: "install", program: actualCheck ? "node" : "npm",
      args: actualCheck ? ["--version"] : ["ci"], timeout_ms: 120000 }],
    commands: [{ id: "arch", program: actualCheck ? "node" : "npm",
      args: actualCheck ? ["--version"] : ["run", "arch"], timeout_ms: 60000 }],
  }
  const hash = verificationContractHash(contract)
  const candidate_id = "cand-" + "a".repeat(64)
  const frozenTree = treeHash([])
  const candidate = { candidate_id, verification_contract: contract, base: { files: [] }, overlay: [], deletions: [], tree_hash: frozenTree,
    manifest: { verification_contract: { contract_hash: hash } } }
  const commit = async (type, body) => {
    const lease = await c.acquire("root")
    const snap = await c.snapshot()
    return c.commit({ operation_id: `fixture:${snap.state.revision}:${type}`, operation_type: type, body }, {
      holder_session_id: "root", expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token,
    })
  }
  await commit("MANDATE_APPROVE", { execution_id: "E", mandate_id: "M", max_wus: 1,
    total_seconds: 1200, time_policy: "WU_PLANNING_ESTIMATES",
    authority_kind: "OWNER_APPROVED_EPIC", source_artifact_id: "epic", source_record_key: "key",
    source_hash: "b".repeat(64), wu_sequence: ["WU4"] })
  await commit("WU_ACTIVATE", { wu_id: "WU4", mandate_id: "M", contract: { wu_id: "WU4",
    verification_contract: contract, verification_contract_hash: hash, active_seconds: 600 } })
  await commit("FREEZE_CANDIDATE", { candidate_id, wu_id: "WU4", manifest_hash: "manifest", tree_hash: frozenTree })
  if (receiptMode !== "absent") {
    const receipt = createVerificationReceipt({
      candidate_id, verification_contract_hash: hash,
      check_id: receiptMode === "different-check" ? "lint" : "arch",
      status: "FAIL", setup_results: receiptMode === "non-timeout"
        ? [{ id: "install", ok: false, timedOut: false, exitCode: 1 }]
        : [{ id: "install", ok: false, timedOut: true, exitCode: null, signal: "SIGKILL" }],
      durationMs: 120000,
    })
    await writeVerificationReceipt(receiptsDir, receipt)
  }
  await commit("BLOCK", { class: blockClass, reason })
  const params = { controller: c, candidate, checkId: "arch", context: { sessionID: "root" },
    runtimeSession: { id: "root", agent: "harness-orchestrator" }, receiptsDir }
  const pass = () => ({
    status: "PASS", candidate_id, check_id: "arch", verification_contract_hash: hash,
    tree_hash: frozenTree, fingerprint: { node: process.version, timestamp: new Date().toISOString() },
    setup_results: [{ id: "install", ok: true, timedOut: false, exitCode: 0 }],
    stdout: "arch PASS", exitCode: 0,
  })
  return { c, commit, params, pass, receiptsDir, hash, candidate }
}

test("setup retry with a historical immutable timed-out receipt clears only the matched tooling stop after full-check PASS", async t => {
  const f = await fixture(t)
  const before = (await f.c.snapshot()).state
  assert.equal(recoveryAction(before).action, "harness_retry_blocked_verification")
  const result = await retryBlockedFrozenVerification({
    ...f.params,
    run: async (_candidate, check, { budgetMs }) => {
      assert.equal(check, "arch")
      assert.ok(budgetMs > 0 && budgetMs <= 180000)
      assert.equal((await f.c.snapshot()).state.blocker.class, "BLOCKED_TOOLING")
      return f.pass()
    },
  })
  assert.equal(result.status, "PASS")
  assert.equal(result.recovery, "TOOLING_BLOCKER_RESOLVED")
  assert.match(result.evidence_id, /^verify-[a-f0-9]{64}$/)
  const { state, events } = await f.c.snapshot()
  assert.equal(state.blocker, null)
  assert.equal(state.last_blocker_resolution.recovery_evidence.pass_receipt_id, result.evidence_id)
  assert.equal(state.last_blocker_resolution.blocked_at_revision, before.blocker.at_revision)
  assert.equal(state.budget.active_phase, null)
  assert.equal(state.wu.wu_id, "WU4")
  assert.equal(events.filter(e => e.operation_type === "VERIFICATION_RETRY_ATTEMPT").length, 1)
  assert.equal(events.filter(e => e.operation_type === "CLEAR_BLOCKER").length, 1)
  await assert.rejects(retryBlockedFrozenVerification({ ...f.params, run: async () => assert.fail() }), /INELIGIBLE/)
})

test("failed full check leaves tooling stop, preserves budget charging and disallows endless retries", async t => {
  const f = await fixture(t)
  const result = await retryBlockedFrozenVerification({ ...f.params,
    run: async () => ({ ...f.pass(), status: "FAIL", exitCode: 1, stdout: "", stderr: "arch failed" }) })
  assert.equal(result.status, "FAIL")
  assert.equal(result.recovery, "UNRESOLVED_SETUP_RETRY_FAILED")
  assert.equal((await f.c.snapshot()).state.blocker.class, "BLOCKED_TOOLING")
  assert.equal(recoveryAction((await f.c.snapshot()).state).action, "clear_blocker", "a failed one-shot retry must not be suggested again")
  await assert.rejects(retryBlockedFrozenVerification({ ...f.params, run: async () => assert.fail() }),
    /ALREADY_ATTEMPTED/)
  const state = (await f.c.snapshot()).state
  assert.equal(state.budget.active_phase, null)
  assert.equal((await f.c.snapshot()).events.filter(e => e.operation_type === "VERIFICATION_RETRY_ATTEMPT").length, 1)
})

for (const mode of ["absent", "different-check", "non-timeout"]) {
  test(`no recovery when prior verification evidence is ${mode}`, async t => {
    const f = await fixture(t, { receiptMode: mode })
    const before = await f.c.snapshot()
    await assert.rejects(retryBlockedFrozenVerification({ ...f.params,
      run: async () => assert.fail("must never execute") }), /SETUP_RECOVERY_NO_/)
    assert.deepEqual((await f.c.snapshot()).events, before.events)
  })
}

test("tampered receipts, wrong WU and unrelated blocker fail without a verification attempt", async t => {
  const f = await fixture(t)
  const { readdir } = await import("node:fs/promises")
  const file = (await readdir(f.receiptsDir))[0]
  await writeFile(join(f.receiptsDir, file), "{}")
  await assert.rejects(retryBlockedFrozenVerification({ ...f.params, run: async () => assert.fail() }),
    /RECEIPT_TAMPERED/)
  const authority = await fixture(t, { blockClass: "BLOCKED_AUTHORITY" })
  await assert.rejects(retryBlockedFrozenVerification({ ...authority.params, run: async () => assert.fail() }),
    /SETUP_RECOVERY_INELIGIBLE/)
  const unrelated = await fixture(t, { reason: "Unrelated API permission error" })
  await assert.rejects(retryBlockedFrozenVerification({ ...unrelated.params, run: async () => assert.fail() }),
    /SETUP_RECOVERY_INELIGIBLE/)
})

test("only the real root session can retry; child and foreign agent are denied", async t => {
  const f = await fixture(t)
  const before = await f.c.snapshot()
  for (const runtimeSession of [
    { id: "root", agent: "harness-reviewer" },
    { id: "child", agent: "harness-orchestrator" },
    { id: "root", parentID: "other", agent: "harness-orchestrator" },
  ]) {
    await assert.rejects(retryBlockedFrozenVerification({
      ...f.params, runtimeSession, run: async () => assert.fail(),
    }), /SETUP_RECOVERY_ROOT_REQUIRED/)
  }
  assert.deepEqual((await f.c.snapshot()).events, before.events)
})


test("real frozen candidate runner executes setup and declared check before clearing tooling blocker", async t => {
  const f = await fixture(t, { actualCheck: true })
  const result = await retryBlockedFrozenVerification({ ...f.params })
  assert.equal(result.status, "PASS")
  assert.equal(result.recovery, "TOOLING_BLOCKER_RESOLVED")
  assert.equal(result.check_id, "arch")
  assert.equal(result.setup_results.length, 1)
  assert.equal(result.setup_results[0].id, "install")
  assert.equal(result.setup_results[0].ok, true)
  assert.ok(result.stdout.trim().startsWith("v"))
  const state = (await f.c.snapshot()).state
  assert.equal(state.blocker, null)
  assert.ok(state.budget.used_seconds >= 0)
})

test("a forged partial PASS cannot clear a tooling blocker without complete frozen setup proof", async t => {
  const f = await fixture(t)
  const before = await f.c.snapshot()
  await assert.rejects(retryBlockedFrozenVerification({ ...f.params, run: async () => ({
    ...f.pass(), setup_results: [],
  }) }), /SETUP_RECOVERY_INCOMPLETE_PASS/)
  const after = await f.c.snapshot()
  assert.equal(after.state.blocker.class, "BLOCKED_TOOLING")
  assert.equal(after.events.filter(e => e.operation_type === "VERIFICATION_RETRY_ATTEMPT").length, 1)
  assert.ok(after.state.revision > before.state.revision)
})
