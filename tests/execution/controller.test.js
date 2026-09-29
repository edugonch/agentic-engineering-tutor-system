import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"

const mandate = (controller, holder, { mandate_id = "M1" } = {}) =>
  controller.commit(
    { operation_id: `${holder}:mandate`, operation_type: "MANDATE_APPROVE", body: { execution_id: `${holder}:exec`, mandate_id, mandate_revision: "r0", max_wus: 4, total_seconds: 60 } },
    { holder_session_id: holder, expected_revision: 0 },
  )

test("commits apply compare-and-swap and reject a stale revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-cas-"))
  try {
    const controller = await createExecutionController({ root })
    await controller.acquire("A")
    await mandate(controller, "A")
    // A second commit using the same (now stale) expected_revision fails.
    await assert.rejects(
      controller.commit({ operation_id: "A:other", operation_type: "CHECKPOINT", body: { note: "x" } }, { holder_session_id: "A", expected_revision: 0 }),
      /Stale revision/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a commit requires a valid lease held by the caller", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-lease-"))
  try {
    const controller = await createExecutionController({ root })
    await assert.rejects(
      controller.commit({ operation_id: "x", operation_type: "CHECKPOINT", body: {} }, { holder_session_id: "A", expected_revision: 0 }),
      /No valid execution lease/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a zombie controller is denied by fencing after lease transfer", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-fencing-"))
  try {
    let clock = 0
    const controller = await createExecutionController({ root, now: () => clock, lease_ttl_ms: 1000 })
    await controller.acquire("A") // token 1
    await mandate(controller, "A")

    clock = 2000 // A's lease expires
    await controller.acquire("B") // token 2, ownership transfers

    // A wakes and tries to write; fencing must deny even though no new event landed.
    await assert.rejects(
      controller.commit({ operation_id: "A:zombie", operation_type: "CHECKPOINT", body: { note: "z" } }, { holder_session_id: "A", expected_revision: 1 }),
      /Fencing conflict/,
    )
    const snap = await controller.snapshot()
    assert.equal(snap.lease.fencing_token, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("operation_id replay returns the prior result; different content conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-idem-"))
  try {
    const controller = await createExecutionController({ root })
    await controller.acquire("A")
    await mandate(controller, "A")
    const op = { operation_id: "A:checkpoint", operation_type: "CHECKPOINT", body: { note: "first" }, result: { done: true } }
    const first = await controller.commit(op, { holder_session_id: "A", expected_revision: 1 })
    assert.equal(first.status, "committed")

    const replay = await controller.commit(op, { holder_session_id: "A", expected_revision: 2 })
    assert.equal(replay.status, "replayed")
    assert.deepEqual(replay.result, { done: true })

    await assert.rejects(
      controller.commit({ operation_id: "A:checkpoint", operation_type: "CHECKPOINT", body: { note: "DIFFERENT" } }, { holder_session_id: "A", expected_revision: 2 }),
      /reused with different content/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("budget accumulates and never resets across a rebuild", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-budget-"))
  try {
    const controller = await createExecutionController({ root })
    await controller.acquire("A")
    await mandate(controller, "A")
    await controller.commit({ operation_id: "A:ps", operation_type: "PHASE_START", body: { phase: "ACTIVE", started_at: 0 } }, { holder_session_id: "A", expected_revision: 1 })
    await controller.commit({ operation_id: "A:pe", operation_type: "PHASE_END", body: { phase: "ACTIVE", ended_at: 100 } }, { holder_session_id: "A", expected_revision: 2 })
    assert.equal((await controller.snapshot()).state.budget.used_seconds, 100)

    // Simulate a restart: a fresh controller on the same dir projects the same used time.
    const restarted = await createExecutionController({ root })
    assert.equal((await restarted.snapshot()).state.budget.used_seconds, 100)

    // Continue: accumulate a delta on top, never reset.
    await restarted.acquire("A")
    await restarted.commit({ operation_id: "A:ps2", operation_type: "PHASE_START", body: { phase: "ACTIVE", started_at: 200 } }, { holder_session_id: "A", expected_revision: 3 })
    await restarted.commit({ operation_id: "A:pe2", operation_type: "PHASE_END", body: { phase: "ACTIVE", ended_at: 250 } }, { holder_session_id: "A", expected_revision: 4 })
    assert.equal((await restarted.snapshot()).state.budget.used_seconds, 150)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("dispatch lifecycle reconciles without auto-relaunch", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-dispatch-"))
  try {
    const controller = await createExecutionController({ root })
    await controller.acquire("A")
    await mandate(controller, "A")
    await controller.commit({ operation_id: "A:res", operation_type: "DISPATCH_RESERVE", body: { dispatch_id: "dsp-1" } }, { holder_session_id: "A", expected_revision: 1 })
    await controller.commit({ operation_id: "A:prep", operation_type: "DISPATCH_PREPARE", body: { dispatch_id: "dsp-1" } }, { holder_session_id: "A", expected_revision: 2 })
    await controller.commit({ operation_id: "A:launch", operation_type: "DISPATCH_LAUNCH", body: { dispatch_id: "dsp-1", session_id: "ses-1" } }, { holder_session_id: "A", expected_revision: 3 })

    // Ambiguous-launch recovery: report UNRESOLVED and do not relaunch.
    const rec = await controller.reconcileDispatch("dsp-1")
    assert.equal(rec.verdict, "UNRESOLVED")
    assert.equal(rec.session_id, "ses-1")
    assert.equal((await controller.snapshot()).state.dispatches["dsp-1"].status, "launched")

    await controller.commit({ operation_id: "A:fin", operation_type: "DISPATCH_FINISH", body: { dispatch_id: "dsp-1", result: "ok" } }, { holder_session_id: "A", expected_revision: 4 })
    assert.equal((await controller.reconcileDispatch("dsp-1")).verdict, "COMPLETED")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a permission blocker forbids any further dispatch or new WU", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-block-"))
  try {
    const controller = await createExecutionController({ root })
    await controller.acquire("A")
    await mandate(controller, "A")
    await controller.commit({ operation_id: "A:block", operation_type: "BLOCK", body: { class: "BLOCKED_PERMISSION", reason: "shell denied" } }, { holder_session_id: "A", expected_revision: 1 })

    await assert.rejects(
      controller.commit({ operation_id: "A:res", operation_type: "DISPATCH_RESERVE", body: { dispatch_id: "dsp-2" } }, { holder_session_id: "A", expected_revision: 2 }),
      /Forward execution is blocked/,
    )
    await assert.rejects(
      controller.commit({ operation_id: "A:wu2", operation_type: "WU_ACTIVATE", body: { wu_id: "WU-02", mandate_id: "M1" } }, { holder_session_id: "A", expected_revision: 2 }),
      /Forward execution is blocked/,
    )

    // budget and checkpoint preserved through the blocker
    const snap = await controller.snapshot()
    assert.equal(snap.state.blocker.class, "BLOCKED_PERMISSION")
    assert.equal(snap.state.budget.used_seconds, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
