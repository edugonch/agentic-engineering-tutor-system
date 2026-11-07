import test from "node:test"
import assert from "node:assert/strict"
import { inspectOrphanBuilderRisk, STABLE_RUNTIME_WINDOW_MS } from "../../src/execution/orphan-circuit-breaker.js"

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
