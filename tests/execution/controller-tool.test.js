import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runExecutionController } from "../../src/execution/controller-tool.js"

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-tool-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test("init → status → verify roundtrip", async () => {
  await withRoot(async (root) => {
    const init = await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    assert.equal(init.commit_status, "committed")
    assert.equal(init.revision, 1)

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.revision, 1)
    assert.equal(status.budget.total_seconds, 100)
    assert.equal(status.budget.available_seconds, 100)

    const v = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(v.passed, true)
  })
})

test("full dispatch lifecycle: reserve → launch → finish → reconcile → verify", async () => {
  await withRoot(async (root) => {
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 10 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })
    await runExecutionController(root, { action: "record_launch", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", launch_session_id: "ext-1" })
    await runExecutionController(root, { action: "record_finish", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", result: "ok" })

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.dispatches[0].status, "finished")

    const rec = await runExecutionController(root, { action: "reconcile", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })
    assert.equal(rec.found, true)

    const after = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(after.dispatches[0].status, "result_reconciled")
    assert.equal(after.budget.used_seconds, 10)
    assert.equal(after.budget.reserved_seconds, 0)

    const v = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(v.passed, true)
  })
})

test("ambiguous path: prepare_launch → mark_ambiguous → recover → verify", async () => {
  await withRoot(async (root) => {
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 5 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })
    await runExecutionController(root, { action: "mark_ambiguous", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })

    const recover = await runExecutionController(root, { action: "recover", execution_id: "E1" })
    assert.deepEqual(recover.classification.ambiguous, ["d1"])
    assert.deepEqual(recover.plan.requires_investigation, ["d1"])

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.dispatches[0].status, "ambiguous")
    assert.equal(status.budget.reserved_seconds, 5) // still held

    const v = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(v.passed, true)
  })
})

test("a repeated reserve with the same dispatch_id is a replay, not a double reservation", async () => {
  await withRoot(async (root) => {
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    const first = await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 10 })
    assert.equal(first.commit_status, "committed")

    const second = await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 10 })
    assert.equal(second.commit_status, "replayed")

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.budget.reserved_seconds, 10) // not 20
  })
})

test("release is refused for a launched dispatch (no force release)", async () => {
  await withRoot(async (root) => {
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 5 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })
    await runExecutionController(root, { action: "record_launch", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", launch_session_id: "ext-1" })

    await assert.rejects(
      runExecutionController(root, { action: "release", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" }),
      /never-launched/,
    )
  })
})

test("release succeeds for a never-launched dispatch", async () => {
  await withRoot(async (root) => {
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 5 })
    const rel = await runExecutionController(root, { action: "release", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })
    assert.equal(rel.commit_status, "committed")

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.dispatches[0].status, "released")
    assert.equal(status.budget.reserved_seconds, 0)

    const v = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(v.passed, true)
  })
})

test("WU lifecycle: activate_wu → record_candidate → record_review → checkpoint → complete → verify", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: sid, total_seconds: 100 })

    const act = await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    assert.equal(act.commit_status, "committed")
    assert.equal(act.wu.wu_id, "WU-01")
    assert.equal(act.wu.origin, "DERIVED")
    assert.equal(act.wu.execution_authorization, "AUTHORIZED_BY_MANDATE")

    const freeze = await runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: "cand-test", manifest_hash: "mh1", tree_hash: "th1" })
    assert.equal(freeze.commit_status, "committed")
    assert.deepEqual(freeze.candidates["cand-test"], { manifest_hash: "mh1", tree_hash: "th1", manifest: null })

    const review = await runExecutionController(root, { action: "record_review", execution_id: "E1", session_id: sid, candidate_id: "cand-test", verdict: "PASS", candidate_hashes: { manifest_hash: "mh1", tree_hash: "th1" }, reviewer: "harness-reviewer" })
    assert.equal(review.commit_status, "committed")
    assert.equal(review.reviews["cand-test"].verdict, "PASS")

    const checkpoint = await runExecutionController(root, { action: "checkpoint", execution_id: "E1", session_id: sid, note: "frozen+reviewed" })
    assert.equal(checkpoint.commit_status, "committed")
    assert.equal(checkpoint.checkpoint.note, "frozen+reviewed")

    const complete = await runExecutionController(root, { action: "complete", execution_id: "E1", session_id: sid, result: "WU-01-done" })
    assert.equal(complete.commit_status, "committed")
    assert.equal(complete.completed, true)

    const v = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(v.passed, true)
  })
})

test("activate_wu with a non-matching mandate_id is rejected (authority is mandate-bound)", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: sid, total_seconds: 100 })
    await assert.rejects(
      runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "WRONG" }),
      /mandate mismatch/,
    )
  })
})

test("record_review against a different candidate hash is rejected (no cross-candidate accreditation)", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: sid, total_seconds: 100 })
    await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    await runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: "cand-test", manifest_hash: "mh1", tree_hash: "th1" })
    await assert.rejects(
      runExecutionController(root, { action: "record_review", execution_id: "E1", session_id: sid, candidate_id: "cand-test", verdict: "PASS", candidate_hashes: { manifest_hash: "mh1", tree_hash: "WRONG" } }),
      /hash mismatch/,
    )
  })
})
