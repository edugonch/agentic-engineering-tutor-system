import test from "node:test"
import assert from "node:assert/strict"
import { deliveryMetrics } from "../../src/execution/delivery-metrics.js"

test("delivery accounting distinguishes accepted WUs from terminated builders and orphan reservations", () => {
  const state = {
    wu: { wu_id: "WU-03", completed: false },
    activated_wu_ids: ["WU-01", "WU-02", "WU-03"],
    completed_wus: { "WU-01": {}, "WU-02": {} },
    candidates: {}, reviews: { a: { verdict: "PASS" }, b: { verdict: "CHANGES_REQUIRED" } },
    budget: { total_seconds: 20000, used_seconds: 6500, reserved_seconds: 1000 },
    dispatches: {
      a: { wu_id: "WU-01", status: "result_reconciled", expected_agent: "harness-builder", actual_consumption: 1600 },
      b: { wu_id: "WU-02", status: "result_reconciled", expected_agent: "harness-reviewer", actual_consumption: 400 },
      c: { wu_id: "WU-03", status: "abandoned_reconciled", expected_agent: "harness-builder", actual_consumption: 1800 },
      d: { wu_id: "WU-03", status: "abandoned_reconciled", expected_agent: "harness-builder", actual_consumption: 1800 },
      e: { wu_id: "WU-03", status: "reserved", expected_agent: "harness-builder", reserved_seconds: 1000 },
      f: { wu_id: "WU-03", status: "released", expected_agent: "harness-builder", reserved_seconds: 500 },
    },
  }
  const original = structuredClone(state)
  const x = deliveryMetrics(state)
  assert.deepEqual(x, {
    completed_wu_count: 2,
    total_activated_wu_count: 3,
    accepted_candidate_count: 1,
    settled_builder_dispatch_count: 1,
    orphaned_dispatch_count: 2,
    orphaned_builder_count: 2,
    orphan_conservatively_charged_seconds: 3600,
    reconciled_dispatch_seconds: 2000,
    active_wu_orphan_count: 2,
    unsettled_dispatch_count: 1,
    epic_used_seconds: 6500,
    remaining_unclassified_seconds: 900,
    productive_engineering_seconds: "UNKNOWN",
    runtime_restart_cause: "UNVERIFIED",
  })
  assert.deepEqual(state, original)
})

test("missing historical budget and incomplete dispatch envelopes remain explicitly unknown", () => {
  const x = deliveryMetrics({
    activated_wu_ids: [], dispatches: { legacy: {
      status: "result_reconciled", expected_agent: "harness-builder", actual_consumption: null,
    } },
  })
  assert.equal(x.completed_wu_count, 0)
  assert.equal(x.reconciled_dispatch_seconds, 0)
  assert.equal(x.epic_used_seconds, null)
  assert.equal("remaining_unclassified_seconds" in x, false)
  assert.equal(x.productive_engineering_seconds, "UNKNOWN")
})
