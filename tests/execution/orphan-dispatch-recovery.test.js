import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runExecutionController, claimDispatchLaunch } from "../../src/execution/controller-tool.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { seedWuContract } from "./wu-fixture.js"
import { project, initialState, applyEvent } from "../../src/execution/state.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { stableHash } from "../../src/execution/serialize.js"

const EPIC_CONTENT = (mergePolicy = "none", ci = []) =>
  `test epic\nexecution_mandate: ${JSON.stringify({ max_wus: 4, total_seconds: 100, merge_policy: mergePolicy, required_ci_checks: ci })}`

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-orphan-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

async function setupExecution(root, sid = "ses-orchestrator") {
  await recordKnowledgeArtifact(root, {
    artifact_type: "epic", artifact_id: "epic-001", status: "APPROVED", owner_confirmed: true,
    title: "Test Epic", content: EPIC_CONTENT(), source_refs: ["https://example.com/epic-source"],
  })
  await seedWuContract(root, "WU-01", "epic-001", 100)
  await runExecutionController(root, { action: "approve_mandate", execution_id: "E1", session_id: sid, epic_artifact_id: "epic-001" })
  await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
}

async function launchBuilder(root, sid, { dispatch_id = "dsp-1", reserved_seconds = 10, child_session_id = "ses-child-1", call_id = "call-launch-1" } = {}) {
  await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: sid, dispatch_id, reserved_seconds })
  await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: sid, dispatch_id, launch_agent: "harness-builder" })
  await claimDispatchLaunch(root, { execution_id: "E1", dispatch_id, call_id, session_id: sid })
  await runExecutionController(root, { action: "record_launch", execution_id: "E1", session_id: sid, dispatch_id, launch_session_id: child_session_id })
}

const orphanEvidence = (childSessionId, overrides = {}) => ({
  child_session_id: childSessionId,
  idle_observation: "observed",
  unsettled_tools: false,
  parent_call_status: "error",
  parent_child_status: "interrupted",
  ...overrides,
})

test("orphan recovery: declares a launched builder orphan, clears tooling blocker, consumes reservation", async () => {
  await withRoot(async (root) => {
    const sid = "ses-orchestrator"
    await setupExecution(root, sid)
    await launchBuilder(root, sid)
    await runExecutionController(root, { action: "block", execution_id: "E1", session_id: sid, class: "BLOCKED_TOOLING", reason: "OpenCode restart; child idle" })

    const res = await runExecutionController(root, {
      action: "declare_orphan_dispatch", execution_id: "E1", session_id: sid, dispatch_id: "dsp-1",
      evidence: orphanEvidence("ses-child-1"), resolution: "Child session verified idle and interrupted; orphan declared.",
    })

    assert.equal(res.commit_status, "committed")
    assert.equal(res.dispatch_status, "orphaned")
    assert.equal(res.cleared_blocker.class, "BLOCKED_TOOLING")
    const d = res.dispatches.find(d => d.dispatch_id === "dsp-1")
    assert.equal(d.status, "orphaned")
    assert.equal(d.reservation_status, "consumed")
    assert.equal(d.actual_consumption, 10)
    assert.ok(res.orphan_evidence_hash)
    assert.equal(res.blocker, null)
  })
})

test("orphan recovery: consumes observed usage when known, otherwise the reservation", async () => {
  await withRoot(async (root) => {
    const sid = "ses-orchestrator"
    await setupExecution(root, sid)
    await launchBuilder(root, sid, { reserved_seconds: 100 })
    // Simulate a captured usage event from the child before it went idle.
    await runExecutionController(root, { action: "block", execution_id: "E1", session_id: sid, class: "BLOCKED_TOOLING", reason: "restart" })
    // Usage would normally be recorded by session-recovery; inject directly via controller commit for this unit test.
    const controller = await createExecutionController({ dir: join(root, ".harness", "execution", "controller", "E1") })
    const lease = await controller.acquire(sid)
    let snap = await controller.snapshot()
    await controller.commit(
      { operation_id: "E1:usage:dsp-1", operation_type: "DISPATCH_USAGE",
        body: { dispatch_id: "dsp-1", session_id: "ses-child-1", call_id: snap.state.dispatches["dsp-1"].launch_call_id, source: "runtime.monotonic_dispatch_envelope", seconds: 23 } },
      { holder_session_id: sid, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token },
    )

    const res = await runExecutionController(root, {
      action: "declare_orphan_dispatch", execution_id: "E1", session_id: sid, dispatch_id: "dsp-1",
      evidence: orphanEvidence("ses-child-1"), resolution: "Usage known; charge observed wall time.",
    })
    const d = res.dispatches.find(d => d.dispatch_id === "dsp-1")
    assert.equal(d.actual_consumption, 23)
    assert.equal(d.consumption_basis, "observed_wall_upper_bound")
  })
})

test("orphan recovery: rejects identity mismatch", async () => {
  await withRoot(async (root) => {
    const sid = "ses-orchestrator"
    await setupExecution(root, sid)
    await launchBuilder(root, sid, { child_session_id: "ses-real-child" })
    await runExecutionController(root, { action: "block", execution_id: "E1", session_id: sid, class: "BLOCKED_TOOLING", reason: "restart" })

    await assert.rejects(
      runExecutionController(root, {
        action: "declare_orphan_dispatch", execution_id: "E1", session_id: sid, dispatch_id: "dsp-1",
        evidence: orphanEvidence("ses-impostor"), resolution: "wrong child",
      }),
      /evidence child_session_id does not match bound dispatch session/,
    )
  })
})

test("orphan recovery: rejects unsettled tools", async () => {
  await withRoot(async (root) => {
    const sid = "ses-orchestrator"
    await setupExecution(root, sid)
    await launchBuilder(root, sid)
    await runExecutionController(root, { action: "block", execution_id: "E1", session_id: sid, class: "BLOCKED_TOOLING", reason: "restart" })

    await assert.rejects(
      runExecutionController(root, {
        action: "declare_orphan_dispatch", execution_id: "E1", session_id: sid, dispatch_id: "dsp-1",
        evidence: orphanEvidence("ses-child-1", { unsettled_tools: true }), resolution: "tools pending",
      }),
      /unsettled_tools === false/,
    )
  })
})

test("orphan recovery: rejects active/idle-not-confirmed observation", async () => {
  await withRoot(async (root) => {
    const sid = "ses-orchestrator"
    await setupExecution(root, sid)
    await launchBuilder(root, sid)
    await runExecutionController(root, { action: "block", execution_id: "E1", session_id: sid, class: "BLOCKED_TOOLING", reason: "restart" })

    await assert.rejects(
      runExecutionController(root, {
        action: "declare_orphan_dispatch", execution_id: "E1", session_id: sid, dispatch_id: "dsp-1",
        evidence: orphanEvidence("ses-child-1", { idle_observation: "not_confirmed" }), resolution: "not idle",
      }),
      /idle_observation in \{observed, interrupted, aborted\}/,
    )
  })
})

test("orphan recovery: prevents replacement builder launch while orphan is being declared and after", async () => {
  await withRoot(async (root) => {
    const sid = "ses-orchestrator"
    await setupExecution(root, sid)
    await launchBuilder(root, sid)
    await runExecutionController(root, { action: "block", execution_id: "E1", session_id: sid, class: "BLOCKED_TOOLING", reason: "restart" })

    // A replacement builder may reserve budget but cannot be prepared while the original is unsettled.
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: sid, dispatch_id: "dsp-2", reserved_seconds: 10 })
    await assert.rejects(
      runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: sid, dispatch_id: "dsp-2", launch_agent: "harness-builder" }),
      /existing builder dispatch dsp-1 is not settled/,
    )

    // After orphan declaration the WU can accept a new builder.
    await runExecutionController(root, {
      action: "declare_orphan_dispatch", execution_id: "E1", session_id: sid, dispatch_id: "dsp-1",
      evidence: orphanEvidence("ses-child-1"), resolution: "orphan declared",
    })

    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: sid, dispatch_id: "dsp-2", reserved_seconds: 10 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: sid, dispatch_id: "dsp-2", launch_agent: "harness-builder" })
    await claimDispatchLaunch(root, { execution_id: "E1", dispatch_id: "dsp-2", call_id: "call-launch-2", session_id: sid })
    await runExecutionController(root, { action: "record_launch", execution_id: "E1", session_id: sid, dispatch_id: "dsp-2", launch_session_id: "ses-child-2" })
    const status = await runExecutionController(root, { action: "status", execution_id: "E1", session_id: sid })
    assert.equal(status.dispatches.find(d => d.dispatch_id === "dsp-2").status, "launched")
  })
})

test("orphan recovery: allows concurrent reviewer dispatch for same WU", async () => {
  await withRoot(async (root) => {
    const sid = "ses-orchestrator"
    await setupExecution(root, sid)
    await launchBuilder(root, sid)
    // A reviewer can still be prepared while the builder is launched.
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: sid, dispatch_id: "review-1", reserved_seconds: 5 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: sid, dispatch_id: "review-1", launch_agent: "harness-reviewer" })
    const status = await runExecutionController(root, { action: "status", execution_id: "E1", session_id: sid })
    assert.equal(status.dispatches.find(d => d.dispatch_id === "review-1").status, "pending_launch")
  })
})

test("orphan recovery: fencing rejects stale finish/handoff/usage after orphan declaration", async () => {
  await withRoot(async (root) => {
    const sid = "ses-orchestrator"
    await setupExecution(root, sid)
    await launchBuilder(root, sid)
    await runExecutionController(root, { action: "block", execution_id: "E1", session_id: sid, class: "BLOCKED_TOOLING", reason: "restart" })
    const before = await runExecutionController(root, {
      action: "declare_orphan_dispatch", execution_id: "E1", session_id: sid, dispatch_id: "dsp-1",
      evidence: orphanEvidence("ses-child-1"), resolution: "orphan declared",
    })
    const d = before.dispatches.find(d => d.dispatch_id === "dsp-1")

    // Stale finish must be rejected.
    await assert.rejects(
      runExecutionController(root, { action: "record_finish", execution_id: "E1", session_id: sid, dispatch_id: "dsp-1", result: "done" }),
      /not launched/,
    )

    // Stale handoff must be rejected.
    const controller = await createExecutionController({ dir: join(root, ".harness", "execution", "controller", "E1") })
    const lease = await controller.acquire(sid)
    let snap = await controller.snapshot()
    await assert.rejects(
      controller.commit(
        { operation_id: "E1:handoff:dsp-1", operation_type: "DISPATCH_HANDOFF",
          body: { dispatch_id: "dsp-1", session_id: "ses-child-1", call_id: d.launch_call_id, content: "late", content_hash: stableHash("late") } },
        { holder_session_id: sid, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token },
      ),
      /Handoff identity mismatch/,
    )
  })
})

test("orphan recovery: state replay preserves orphan event and budget", async () => {
  const events = [
    { sequence: 1, event_id: "e1", operation_id: "op-1", operation_type: "MANDATE_APPROVE", operation_hash: "h1", body: { execution_id: "E1:exec", mandate_id: "M1", mandate_revision: "r0", max_wus: 2, total_seconds: 60, authority_kind: "OWNER_APPROVED_EPIC", source_artifact_id: "epic-001", source_record_key: "rk-1", source_hash: "h1" }, previous_revision: 0, next_revision: 1, fencing_token: 1, timestamp: "t1" },
    { sequence: 2, event_id: "e2", operation_id: "op-2", operation_type: "WU_ACTIVATE", operation_hash: "h2", body: { wu_id: "WU-01", mandate_id: "M1" }, previous_revision: 1, next_revision: 2, fencing_token: 1, timestamp: "t2" },
    { sequence: 3, event_id: "e3", operation_id: "op-3", operation_type: "DISPATCH_RESERVE", operation_hash: "h3", body: { dispatch_id: "d1", reserved_seconds: 15 }, previous_revision: 2, next_revision: 3, fencing_token: 1, timestamp: "t3" },
    { sequence: 4, event_id: "e4", operation_id: "op-4", operation_type: "DISPATCH_PREPARE", operation_hash: "h4", body: { dispatch_id: "d1", prepared_by_session_id: "ses-1", expected_agent: "harness-builder", claim_required: true }, previous_revision: 3, next_revision: 4, fencing_token: 1, timestamp: "t4" },
    { sequence: 5, event_id: "e5", operation_id: "op-5", operation_type: "DISPATCH_LAUNCH_CLAIM", operation_hash: "h5", body: { dispatch_id: "d1", call_id: "call-1" }, previous_revision: 4, next_revision: 5, fencing_token: 1, timestamp: "t5" },
    { sequence: 6, event_id: "e6", operation_id: "op-6", operation_type: "DISPATCH_LAUNCH", operation_hash: "h6", body: { dispatch_id: "d1", session_id: "ses-child-1" }, previous_revision: 5, next_revision: 6, fencing_token: 1, timestamp: "t6" },
    { sequence: 7, event_id: "e7", operation_id: "op-7", operation_type: "DISPATCH_ORPHAN", operation_hash: "h7", body: { dispatch_id: "d1", session_id: "ses-child-1", actual_consumption: null, evidence: { child_session_id: "ses-child-1", idle_observation: "interrupted", unsettled_tools: false }, evidence_hash: "h-ev", reason: "replay", fencing_token: 2 }, previous_revision: 6, next_revision: 7, fencing_token: 2, timestamp: "t7" },
  ]
  const state = project(events)
  assert.equal(state.dispatches.d1.status, "orphaned")
  assert.equal(state.dispatches.d1.reservation_status, "consumed")
  assert.equal(state.dispatches.d1.actual_consumption, 15)
  assert.equal(state.budget.reserved_seconds, 0)
  assert.equal(state.budget.used_seconds, 15)
})

test("recoveryAction returns structured orphan cause for launched dispatch without handoff/usage", async () => {
  await withRoot(async (root) => {
    const sid = "ses-orchestrator"
    await setupExecution(root, sid)
    await launchBuilder(root, sid)
    await runExecutionController(root, { action: "block", execution_id: "E1", session_id: sid, class: "BLOCKED_TOOLING", reason: "restart" })
    const status = await runExecutionController(root, { action: "status", execution_id: "E1", session_id: sid })
    assert.equal(status.next_action.kind, "ORPHAN_DISPATCH_CANDIDATE")
    assert.equal(status.next_action.action, "declare_orphan_dispatch")
    assert.equal(status.next_action.dispatch_id, "dsp-1")
    assert.ok(!status.next_action.condition.toLowerCase().includes("npm"))
  })
})

test("recoveryAction never recommends npm install from blocker text", async () => {
  let state = initialState()
  state = applyEvent(state, { operation_type: "BLOCK", body: { class: "BLOCKED_TOOLING", reason: "npm install failed: cannot find module 'left-pad'" }, next_revision: 1 })
  const { recoveryAction } = await import("../../src/execution/progress.js")
  const action = recoveryAction(state)
  assert.notEqual(action.action, "npm_install")
  assert.ok(!action.condition.toLowerCase().includes("npm install"))
})
