import test from "node:test"
import assert from "node:assert/strict"
import { inspectOrphanBuilderRisk, STABLE_RUNTIME_WINDOW_MS } from "../../src/execution/orphan-circuit-breaker.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { runExecutionController, claimDispatchLaunch } from "../../src/execution/controller-tool.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { seedWuContract } from "./wu-fixture.js"

const at = Date.parse("2026-11-07T15:00:00.000Z")
function fixture() {
  const settled = (id, timestamp, agent = "harness-builder") => ({
    id, wu_id: "E05-27-E", expected_agent: agent, status: "abandoned_reconciled",
    actual_consumption: 1800, reserved_seconds: 1800,
    fence: { timestamp: new Date(timestamp).toISOString() },
  })
  return { wu: { wu_id: "E05-27-E", completed: false }, dispatches: {
    "build-1": { wu_id: "E05-27-E", expected_agent: "harness-builder", status: "result_reconciled" },
    "build-2": settled("build-2", at - 12 * 60000),
    "build-3": settled("build-3", at - 8 * 60000),
    "review-1": settled("review-1", at - 7 * 60000, "harness-reviewer"),
    "other-wu": { ...settled("other-wu", at - 5 * 60000), wu_id: "E05-26-E" },
  } }
}

test("read-only risk report never attributes unknown cause to OpenCode restart", () => {
  const s = fixture()
  const result = inspectOrphanBuilderRisk(s, { nowMs: at })
  assert.equal(result.repeated_interruption_pattern, true)
  assert.equal(result.abandoned_builder_dispatch_count, 2)
  assert.deepEqual(result.abandoned_builder_dispatch_ids, ["build-2", "build-3"])
  assert.equal(result.conservatively_charged_seconds, 3600)
  assert.equal(result.interruption_cause, "UNVERIFIED")
  assert.equal(result.launch_temporarily_blocked, undefined)
  assert.deepEqual(s.dispatches["build-2"].fence, { timestamp: new Date(at - 12 * 60000).toISOString() })
})

test("two recent aborted builders hold only new builder admission until observed runtime and cooldown stabilize", () => {
  const s = fixture()
  const recent = inspectOrphanBuilderRisk(s, { nowMs: at, runtimeLoadedAtMs: at - 5 * 60000 })
  assert.equal(recent.launch_temporarily_blocked, true)
  assert.equal(recent.retry_after_seconds, 30 * 60 - 5 * 60)
  const oldRuntimeRecentAbandon = inspectOrphanBuilderRisk(s, {
    nowMs: at, runtimeLoadedAtMs: at - STABLE_RUNTIME_WINDOW_MS * 2,
  })
  assert.equal(oldRuntimeRecentAbandon.launch_temporarily_blocked, true)
  assert.equal(oldRuntimeRecentAbandon.retry_after_seconds, 22 * 60)
  const stable = inspectOrphanBuilderRisk(s, {
    nowMs: at + STABLE_RUNTIME_WINDOW_MS, runtimeLoadedAtMs: at - STABLE_RUNTIME_WINDOW_MS * 2,
  })
  assert.equal(stable.launch_temporarily_blocked, false)
  assert.equal(stable.retry_after_seconds, 0)
})

test("normal, reviewer-only, historical-WU and completed execution are not blocked", () => {
  const s = fixture()
  delete s.dispatches["build-3"]
  assert.equal(inspectOrphanBuilderRisk(s, { nowMs: at, runtimeLoadedAtMs: at - 1000 }).launch_temporarily_blocked, false)
  delete s.dispatches["build-2"]
  assert.equal(inspectOrphanBuilderRisk(s, { nowMs: at, runtimeLoadedAtMs: at - 1000 }).abandoned_builder_dispatch_count, 0)
  const complete = fixture()
  complete.wu.completed = true
  assert.equal(inspectOrphanBuilderRisk(complete, { nowMs: at, runtimeLoadedAtMs: at - 1000 }).launch_temporarily_blocked, false)
})

test("a rebooted plugin does not infer that elapsed wall clock before boot is stable uptime", () => {
  const s = fixture()
  const after = at + STABLE_RUNTIME_WINDOW_MS * 2
  const result = inspectOrphanBuilderRisk(s, { nowMs: after, runtimeLoadedAtMs: after - 1000 })
  assert.equal(result.launch_temporarily_blocked, true)
  assert.equal(result.retry_after_seconds, Math.ceil((STABLE_RUNTIME_WINDOW_MS - 1000) / 1000))
  const invalid = inspectOrphanBuilderRisk(s, { nowMs: at, runtimeLoadedAtMs: at + 100 })
  assert.equal(invalid.launch_temporarily_blocked, undefined)
})

test("controller prevents a third rapid orphan builder, without consuming the unlaunched reservation", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-orphan-breaker-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const execution_id = "risk-E1", session_id = "ses_root", epic_id = "EPIC-RISK", wu_id = "W1"
  await recordKnowledgeArtifact(root, {
    artifact_type: "epic", artifact_id: epic_id, title: "Orphan breaker integration",
    status: "APPROVED", owner_confirmed: true, source_refs: ["https://example.org/risk"],
    content: "execution_mandate: " + JSON.stringify({
      max_wus: 1, total_seconds: 10000, merge_policy: "none", wu_sequence: [wu_id],
    }),
  })
  await seedWuContract(root, wu_id, epic_id, 1800)
  const run = (action, more = {}, options = {}) => runExecutionController(root, {
    action, execution_id, session_id, ...more,
  }, undefined, options)
  await run("approve_mandate", { epic_artifact_id: epic_id })
  await run("activate_wu", { wu_id, mandate_id: execution_id + "-MANDATE-001" })
  const controller = await createExecutionController({
    dir: join(root, ".harness", "execution", "controller", execution_id),
  })
  async function commit(operation_type, body, operation_id) {
    const lease = await controller.acquire(session_id)
    const { state } = await controller.snapshot()
    return controller.commit({ operation_id, operation_type, body }, {
      holder_session_id: session_id, expected_revision: state.revision,
      lease_fencing_token: lease.fencing_token,
    })
  }
  for (let i = 1; i <= 2; i++) {
    const dispatch_id = "build-" + i, child_id = "ses_child_" + i
    await run("reserve", { dispatch_id, reserved_seconds: 1800 })
    await run("prepare_launch", { dispatch_id, launch_agent: "harness-builder" })
    await claimDispatchLaunch(root, { execution_id, dispatch_id, call_id: "call_" + i, session_id })
    await run("record_launch", { dispatch_id, launch_session_id: child_id })
    const { state } = await controller.snapshot()
    const proof = {
      kind: "VERIFIED_QUIESCENT_CHILD", child_session_id: child_id,
      parent_session_id: session_id, launch_call_id: "call_" + i,
      agent: "harness-builder", runtime_quiescent: true, pending_tools: 0,
      interrupted: true, fence_hook_installed: true, observation_hash: "a".repeat(64),
    }
    await commit("DISPATCH_FENCE", { dispatch_id,
      expected_revision: state.revision, child_session_id: child_id,
      parent_session_id: session_id, launch_call_id: "call_" + i,
      agent: "harness-builder", wu_id, proof,
    }, "fence-" + i)
    const fenced = (await controller.snapshot()).state.dispatches[dispatch_id]
    await commit("DISPATCH_ABANDON", { dispatch_id, child_session_id: child_id,
      fence_generation: fenced.fence.generation,
      proof: {
        kind: "POST_FENCE_QUIESCENCE", child_session_id: child_id,
        runtime_quiescent: true, pending_tools: 0, fence_enforced: true,
        observation_hash: "b".repeat(64),
      },
    }, "abandon-" + i)
    await commit("DISPATCH_RECONCILE_ABANDONED", { dispatch_id,
      fence_generation: fenced.fence.generation,
    }, "settle-" + i)
  }
  const risk = await run("operational_status", {}, {
    now_ms: Date.now(), runtime_loaded_at_ms: Date.now() - 1000,
  })
  assert.equal(risk.runtime_stability.abandoned_builder_dispatch_count, 2)
  assert.equal(risk.runtime_stability.launch_temporarily_blocked, true)
  assert.equal(risk.runtime_stability.interruption_cause, "UNVERIFIED")
  assert.equal(risk.time_policy, "PLANNING_ESTIMATES_ONLY")
  await run("reserve", { dispatch_id: "build-3", reserved_seconds: 1800 })
  const before = (await controller.snapshot()).state
  await assert.rejects(run("prepare_launch", {
    dispatch_id: "build-3", launch_agent: "harness-builder",
  }, { now_ms: Date.now(), runtime_loaded_at_ms: Date.now() - 1000 }), /RUNTIME_STABILITY_GUARD/)
  const after = (await controller.snapshot()).state
  assert.equal(after.revision, before.revision)
  assert.equal(after.dispatches["build-3"].status, "reserved")
  assert.equal(after.budget.reserved_seconds, 1800)
  await run("release", { dispatch_id: "build-3" })
  const cleared = (await controller.snapshot()).state
  assert.equal(cleared.dispatches["build-3"].status, "released")
  assert.equal(cleared.budget.reserved_seconds, 0)
  assert.equal(cleared.budget.used_seconds, 3600)
})
