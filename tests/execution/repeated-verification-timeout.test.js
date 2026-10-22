import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createVerificationReceipt, writeVerificationReceipt, inspectRepeatedVerificationTimeout,
} from "../../src/execution/verification-results.js"

const candidate = "cand-" + "b".repeat(64)
const contract = "c".repeat(64)
const scope = { candidate_id: candidate, verification_contract_hash: contract, check_id: "jit-test" }

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "harness-timeout-loop-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let sequence = 0
  const record = async (change = {}) => {
    const { setupTimeout = false, ...rest } = change
    const result = { ...scope, status: "FAIL", exitCode: null,
      fingerprint: { timestamp: String(++sequence) }, timedOut: !setupTimeout,
      durationMs: 300000,
      setup_results: setupTimeout ? [{ id: "jit-install", timedOut: true, ok: false }] : [],
      ...rest }
    const receipt = createVerificationReceipt(result)
    await writeVerificationReceipt(dir, receipt)
    return receipt
  }
  return { dir, record }
}

test("virtual E05-07-E: first timeout permits one retry; second blocks unchanged jit-test", async t => {
  const { dir, record } = await fixture(t)
  assert.deepEqual(await inspectRepeatedVerificationTimeout(dir, scope), { blocked: false, timeouts: 0, evidence_ids: [] })
  const first = await record()
  let observed = await inspectRepeatedVerificationTimeout(dir, scope)
  assert.equal(observed.blocked, false)
  assert.equal(observed.timeouts, 1)
  const second = await record()
  observed = await inspectRepeatedVerificationTimeout(dir, scope)
  assert.equal(observed.blocked, true)
  assert.equal(observed.timeouts, 2)
  assert.deepEqual(observed.evidence_ids.sort(), [first.evidence_id, second.evidence_id].sort())
  // Calling the preflight again does not consume time, create another event,
  // relaunch a builder, or invent an acceptance receipt.
  assert.deepEqual(await inspectRepeatedVerificationTimeout(dir, scope), observed)
})

test("an unrelated candidate, check or frozen contract cannot cause a timeout stop", async t => {
  const { dir, record } = await fixture(t)
  await record()
  await record({ setupTimeout: true })
  for (const change of [
    { candidate_id: "cand-" + "a".repeat(64) },
    { verification_contract_hash: "a".repeat(64) },
    { check_id: "jit-lint" },
  ]) {
    assert.equal((await inspectRepeatedVerificationTimeout(dir, { ...scope, ...change })).blocked, false)
  }
  const oldCandidate = await inspectRepeatedVerificationTimeout(dir, scope)
  assert.equal(oldCandidate.blocked, true)
})

test("a valid PASS on the same candidate/check prevents stale timeouts blocking progress", async t => {
  const { dir, record } = await fixture(t)
  await record()
  await record({ setupTimeout: true })
  await record({ status: "PASS", timedOut: false, exitCode: 0 })
  const status = await inspectRepeatedVerificationTimeout(dir, scope)
  assert.equal(status.timeouts, 2)
  assert.equal(status.blocked, false)
})

test("non-timeout assertion failures do not trigger retry guard; tampering fails closed", async t => {
  const { dir, record } = await fixture(t)
  await record({ timedOut: false, exitCode: 1 })
  await record({ timedOut: false, exitCode: 1 })
  assert.equal((await inspectRepeatedVerificationTimeout(dir, scope)).timeouts, 0)
  const corrupted = await record()
  const path = join(dir, corrupted.evidence_id + ".json")
  const original = JSON.parse(await readFile(path, "utf8"))
  original.output.timed_out = false
  await writeFile(path, JSON.stringify(original))
  await assert.rejects(inspectRepeatedVerificationTimeout(dir, scope), /RECEIPT_TAMPERED/)
})
