import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runContinuationProbe } from "../../src/execution/probe.js"

test("probe init records a mandate and verify passes the invariant matrix", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-probe-"))
  try {
    const init = await runContinuationProbe(root, { action: "init", probe_id: "p1", session_id: "ses-1" })
    assert.equal(init.execution_id, "p1:exec")
    assert.equal(init.mandate_id, "p1-MANDATE-001")
    assert.equal(init.authorization, "AUTHORIZED_BY_MANDATE")
    assert.equal(init.dispatches.length, 1)
    assert.equal(init.dispatches[0].dispatch_id, "p1:dsp-0001")

    const verify = await runContinuationProbe(root, { action: "verify", probe_id: "p1", session_id: "ses-1" })
    assert.equal(verify.invariants.passed, true)
    assert.equal(verify.execution_id, "p1:exec")
    assert.equal(verify.wu_id, "p1:WU-01")
    assert.equal(verify.invariants.checks["no duplicate dispatch"], true)
    assert.equal(verify.invariants.checks["authorization is AUTHORIZED_BY_MANDATE (no synthesized approval)"], true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("probe checkpoint settles billable time and preserves identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-probe-cp-"))
  try {
    await runContinuationProbe(root, { action: "init", probe_id: "p1", session_id: "ses-1" })
    const cp = await runContinuationProbe(root, { action: "checkpoint", probe_id: "p1", session_id: "ses-1", note: "mid" })
    assert.equal(cp.checkpoint.note, "mid")
    assert.equal(cp.budget.used_seconds >= 0, true)
    const verify = await runContinuationProbe(root, { action: "verify", probe_id: "p1", session_id: "ses-1" })
    assert.equal(verify.invariants.passed, true)
    assert.equal(verify.mandate_id, "p1-MANDATE-001")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("probe rejects an unsafe probe_id", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-probe-id-"))
  try {
    await assert.rejects(
      runContinuationProbe(root, { action: "verify", probe_id: "..", session_id: "ses-1" }),
      /probe_id/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("probe block records a durable BLOCKED_PERMISSION", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-probe-block-"))
  try {
    await runContinuationProbe(root, { action: "init", probe_id: "p1", session_id: "ses-1" })
    const block = await runContinuationProbe(root, { action: "block", probe_id: "p1", session_id: "ses-1", note: "permission.rejected:webfetch" })
    assert.equal(block.blocker.class, "BLOCKED_PERMISSION")
    const verify = await runContinuationProbe(root, { action: "verify", probe_id: "p1", session_id: "ses-1" })
    assert.equal(verify.blocker.class, "BLOCKED_PERMISSION")
  } finally { await rm(root, { recursive: true, force: true }) }
})
