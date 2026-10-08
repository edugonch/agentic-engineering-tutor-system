import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { DISPATCH_STATUS } from "../../src/execution/constants.js"

// Commit a sequence of steps with a tracked revision, all under one lease token.
async function sequence(controller, holder, token, steps, startRevision = 0) {
  let revision = startRevision
  for (const [operation_id, operation_type, body] of steps) {
    const res = await controller.commit(
      { operation_id, operation_type, body },
      { holder_session_id: holder, expected_revision: revision, lease_fencing_token: token },
    )
    revision = res.revision
  }
  return revision
}

const MANDATE = ["mandate", "MANDATE_APPROVE", { execution_id: "exec-1", mandate_id: "M1", mandate_revision: "r0", max_wus: 4, total_seconds: 100 }]

const dispatchToFinished = (did, reserved = 5, session = "ses-1") => [
  [`res-${did}`, "DISPATCH_RESERVE", { dispatch_id: did, reserved_seconds: reserved }],
  [`prep-${did}`, "DISPATCH_PREPARE", { dispatch_id: did }],
  [`launch-${did}`, "DISPATCH_LAUNCH", { dispatch_id: did, session_id: session }],
  [`finish-${did}`, "DISPATCH_FINISH", { dispatch_id: did, result: "ok" }],
]

test("commit requires lease_fencing_token", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-tokenreq-"))
  try {
    const controller = await createExecutionController({ root })
    await controller.acquire("A")
    await assert.rejects(
      controller.commit({ operation_id: "x", operation_type: "CHECKPOINT", body: {} }, { holder_session_id: "A", expected_revision: 0 }),
      /requires lease_fencing_token/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a stale fencing token from the same holder is rejected (re-acquire gap)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-staletoken-"))
  try {
    let clock = 0
    const controller = await createExecutionController({ root, now: () => clock, lease_ttl_ms: 1000 })
    const lease1 = await controller.acquire("A") // token 1
    assert.equal(lease1.fencing_token, 1)

    clock = 2000 // lease 1 expires
    const lease2 = await controller.acquire("A") // same holder re-acquires → token 2
    assert.equal(lease2.fencing_token, 2)

    // Old async work from the same session wakes with the stale token 1:
    // holder still matches, but the token must be rejected.
    await assert.rejects(
      controller.commit({ operation_id: "A:stale", operation_type: "CHECKPOINT", body: { note: "z" } }, { holder_session_id: "A", expected_revision: 0, lease_fencing_token: lease1.fencing_token }),
      /Stale fencing token/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a reservation above the available budget is denied (hard ceiling)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-ceiling-"))
  try {
    const controller = await createExecutionController({ root })
    const lease = await controller.acquire("A")
    let rev = await sequence(controller, "A", lease.fencing_token, [MANDATE])
    rev = await sequence(controller, "A", lease.fencing_token, [["res-1", "DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 80 }]], rev)
    // available = 100 - 0 - 80 = 20; reserving 30 must be denied.
    await assert.rejects(
      controller.commit({ operation_id: "res-2", operation_type: "DISPATCH_RESERVE", body: { dispatch_id: "d2", reserved_seconds: 30 } }, { holder_session_id: "A", expected_revision: rev, lease_fencing_token: lease.fencing_token }),
      /BLOCKED_BUDGET/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("budget() exposes the derived authorization view (available/exhausted/overrun)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-budgetview-"))
  try {
    const controller = await createExecutionController({ root })
    const lease = await controller.acquire("A")
    // Wall-clock overrun is a reconstructible fact, not a projection error:
    // used (120) exceeds total (100), so available is negative.
    await sequence(controller, "A", lease.fencing_token, [
      MANDATE,
      ["ps", "PHASE_START", { phase: "ACTIVE", started_at: 0 }],
      ["pe", "PHASE_END", { phase: "ACTIVE", ended_at: 120 }],
    ])
    const b = await controller.budget()
    assert.equal(b.used_seconds, 120)
    assert.equal(b.reserved_seconds, 0)
    assert.equal(b.available_seconds, -20)
    assert.equal(b.exhausted, true)
    assert.equal(b.overrun, true)

    // Even though the ledger is over budget, a new reservation is still denied.
    const snap = await controller.snapshot()
    await assert.rejects(
      controller.commit({ operation_id: "res-over", operation_type: "DISPATCH_RESERVE", body: { dispatch_id: "d9", reserved_seconds: 1 } }, { holder_session_id: "A", expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token }),
      /BLOCKED_BUDGET/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("recover() classifies dispatches into canonical categories without mutating", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-recover-"))
  try {
    const controller = await createExecutionController({ root })
    const lease = await controller.acquire("A")
    await sequence(controller, "A", lease.fencing_token, [
      MANDATE,
      ["res-d1", "DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 5 }], // never launched
      ["res-d2", "DISPATCH_RESERVE", { dispatch_id: "d2", reserved_seconds: 5 }],
      ["prep-d2", "DISPATCH_PREPARE", { dispatch_id: "d2" }], // pending_launch
      ["res-d3", "DISPATCH_RESERVE", { dispatch_id: "d3", reserved_seconds: 5 }],
      ["prep-d3", "DISPATCH_PREPARE", { dispatch_id: "d3" }],
      ["launch-d3", "DISPATCH_LAUNCH", { dispatch_id: "d3", session_id: "ses-3" }], // launched
      ...dispatchToFinished("d4", 5), // finished
      ["res-d5", "DISPATCH_RESERVE", { dispatch_id: "d5", reserved_seconds: 5 }],
      ...dispatchToFinished("d6", 5),
      ["rec-d6", "DISPATCH_RECONCILE", { dispatch_id: "d6", actual_consumption: 5 }], // reconciled
      ["res-d7", "DISPATCH_RESERVE", { dispatch_id: "d7", reserved_seconds: 5 }],
      ["rel-d7", "DISPATCH_RELEASE", { dispatch_id: "d7" }], // released
      // Ambiguity prevents new dispatch admission, not historical classification.
      ["amb-d5", "DISPATCH_MARK_AMBIGUOUS", { dispatch_id: "d5" }], // ambiguous
    ])

    const before = await controller.snapshot()
    const report = await controller.recover()
    const after = await controller.snapshot()

    // recover() is observation-only: the projection must not have changed.
    assert.equal(after.state.revision, before.state.revision)

    assert.deepEqual(report.classification.never_launched.sort(), ["d1", "d2"])
    assert.deepEqual(report.classification.running_or_launched, ["d3"])
    assert.deepEqual(report.classification.finished_unreconciled, ["d4"])
    assert.deepEqual(report.classification.ambiguous, ["d5"])
    assert.deepEqual(report.classification.resolved.reconciled, ["d6"])
    assert.deepEqual(report.classification.resolved.released, ["d7"])
    assert.deepEqual(report.plan.auto_reconcile, ["d4"])
    assert.deepEqual(report.plan.requires_investigation, ["d5"])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("reconcileAll() reconciles FINISHED only and never touches the others", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-recall-"))
  try {
    const controller = await createExecutionController({ root })
    const lease = await controller.acquire("A")
    await sequence(controller, "A", lease.fencing_token, [
      MANDATE,
      ...dispatchToFinished("d1", 10),
      ["res-d2", "DISPATCH_RESERVE", { dispatch_id: "d2", reserved_seconds: 5 }], // reserved
      ["res-d3", "DISPATCH_RESERVE", { dispatch_id: "d3", reserved_seconds: 5 }],
      ["prep-d3", "DISPATCH_PREPARE", { dispatch_id: "d3" }],
      ["launch-d3", "DISPATCH_LAUNCH", { dispatch_id: "d3", session_id: "ses-3" }], // launched
      ["res-d4", "DISPATCH_RESERVE", { dispatch_id: "d4", reserved_seconds: 5 }],
      ["amb-d4", "DISPATCH_MARK_AMBIGUOUS", { dispatch_id: "d4" }], // ambiguous
    ])

    const result = await controller.reconcileAll({ holder_session_id: "A", lease_fencing_token: lease.fencing_token })
    assert.deepEqual(result.reconciled.map((r) => r.dispatch_id), ["d1"])

    const s = await controller.snapshot()
    assert.equal(s.state.dispatches.d1.status, DISPATCH_STATUS.RESULT_RECONCILED)
    assert.equal(s.state.dispatches.d2.status, DISPATCH_STATUS.RESERVED) // untouched
    assert.equal(s.state.dispatches.d3.status, DISPATCH_STATUS.LAUNCHED) // no invented finish
    assert.equal(s.state.dispatches.d4.status, DISPATCH_STATUS.AMBIGUOUS) // untouched
    assert.equal(s.state.budget.used_seconds, 10) // only d1's full reservation consumed
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("reconcileAll() is idempotent across a crash/retry (no double consumption)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-recall-idem-"))
  try {
    const controller = await createExecutionController({ root })
    const lease = await controller.acquire("A")
    await sequence(controller, "A", lease.fencing_token, [MANDATE, ...dispatchToFinished("d1", 10)])

    const first = await controller.reconcileAll({ holder_session_id: "A", lease_fencing_token: lease.fencing_token })
    assert.equal(first.reconciled.length, 1)

    // Simulate a restart + retry: a fresh controller reconciles again.
    const restarted = await createExecutionController({ root })
    const lease2 = await restarted.acquire("A")
    const second = await restarted.reconcileAll({ holder_session_id: "A", lease_fencing_token: lease2.fencing_token })
    assert.equal(second.reconciled.length, 0) // nothing left to reconcile
    assert.equal((await restarted.snapshot()).state.budget.used_seconds, 10) // no double consumption
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("releaseDispatch() releases only never-launched dispatches and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ctl-release-"))
  try {
    const controller = await createExecutionController({ root })
    const lease = await controller.acquire("A")
    let rev = await sequence(controller, "A", lease.fencing_token, [
      MANDATE,
      ["res-d1", "DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 5 }],
    ])

    const first = await controller.releaseDispatch("d1", { holder_session_id: "A", lease_fencing_token: lease.fencing_token, expected_revision: rev })
    assert.equal(first.status, "committed")
    rev = first.revision

    // A retry (same deterministic operation_id) is a replay, not a double release.
    const retry = await controller.releaseDispatch("d1", { holder_session_id: "A", lease_fencing_token: lease.fencing_token, expected_revision: rev })
    assert.equal(retry.status, "replayed")

    const s = await controller.snapshot()
    assert.equal(s.state.dispatches.d1.status, DISPATCH_STATUS.RELEASED)
    assert.equal(s.state.budget.reserved_seconds, 0)

    // A launched dispatch cannot be released.
    rev = await sequence(controller, "A", lease.fencing_token, [["res-d2", "DISPATCH_RESERVE", { dispatch_id: "d2", reserved_seconds: 5 }], ["prep-d2", "DISPATCH_PREPARE", { dispatch_id: "d2" }], ["launch-d2", "DISPATCH_LAUNCH", { dispatch_id: "d2", session_id: "ses-2" }]], rev)
    await assert.rejects(
      controller.releaseDispatch("d2", { holder_session_id: "A", lease_fencing_token: lease.fencing_token, expected_revision: rev }),
      /never-launched/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})
