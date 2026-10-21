import test from "node:test";
import assert from "node:assert/strict";
import { projectOperationalView } from "../../src/execution/operational-view.js";
import { runExecutionController } from "../../src/execution/controller-tool.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function state(overrides = {}) {
  return {
    execution_id: "E1", revision: 8, completed: false, blocker: null,
    mandate: { mandate_id: "M1", authority_kind: "OWNER_APPROVED_EPIC",
      wu_sequence: ["WU-01", "WU-02"], merge_policy: "governed_auto" },
    wu: { wu_id: "WU-01", completed: false }, activated_wu_ids: ["WU-01"],
    budget: { total_seconds: 100, used_seconds: 12, reserved_seconds: 0 },
    dispatches: {}, candidates: {}, reviews: {}, review_history: {}, ...overrides,
  };
}
const candidate = { C1: { wu_id: "WU-01", tree_hash: "tree" } };

test("candidate follows one builder and enters verification", () => {
  assert.equal(projectOperationalView(state()).next_action, "LAUNCH_ONE_BUILDER");
  const result = projectOperationalView(state({ candidates: candidate }));
  assert.equal(result.phase, "VERIFYING");
  assert.equal(result.candidate_id, "C1");
  assert.equal(result.verification, "UNKNOWN");
  assert.equal(result.ci, "UNKNOWN");
});
test("live builder and reviewer are reported without duplicate launch", () => {
  const b = projectOperationalView(state({ dispatches: {
    d1: { wu_id: "WU-01", expected_agent: "harness-builder", status: "launched", session_id: "s1" },
  } }));
  assert.equal(b.phase, "BUILDING");
  assert.equal(b.next_action, "AWAIT_EXISTING_BUILDER");
  assert.equal(b.builder_session_id, "s1");
  const r = projectOperationalView(state({ dispatches: {
    d2: { wu_id: "WU-01", expected_agent: "harness-reviewer", status: "launched", session_id: "s2" },
  } }));
  assert.equal(r.phase, "REVIEWING");
  assert.equal(r.next_action, "AWAIT_INDEPENDENT_REVIEW");
});
test("two correction rounds remain in the same WU; third CHANGES_REQUIRED stops", () => {
  const x = state({ candidates: candidate, reviews: { C1: { verdict: "CHANGES_REQUIRED" } } });
  assert.equal(projectOperationalView(x).next_action, "REPAIR_SAME_WU");
  x.review_history.C1 = [{ verdict: "CHANGES_REQUIRED" }];
  assert.equal(projectOperationalView(x).phase, "REPAIRING");
  x.review_history.C1.push({ verdict: "CHANGES_REQUIRED" });
  assert.equal(projectOperationalView(x).phase, "BLOCKED");
  assert.equal(projectOperationalView(x).next_action, "STOP_REPAIR_LIMIT");
});
test("PASS retains merge gates and completion selects only declared successor", () => {
  const x = state({ candidates: candidate, reviews: { C1: { verdict: "PASS" } } });
  assert.equal(projectOperationalView(x).next_action, "APPLY_GOVERNED_MERGE_GATES");
  x.merge = { status: "VERIFIED", candidate_id: "C1" };
  assert.equal(projectOperationalView(x).next_action, "COMPLETE_WU");
  x.wu = { wu_id: "WU-01", completed: true };
  assert.equal(projectOperationalView(x).phase, "READY");
  assert.equal(projectOperationalView(x).next_wu_id, "WU-02");
  assert.equal(projectOperationalView(x).next_action, "ACTIVATE_NEXT_APPROVED_WU");
});
test("blocker, ambiguous dispatch, budget stop and unapproved mandate fail closed", () => {
  assert.equal(projectOperationalView(state({ blocker: { class: "BLOCKED_TOOLING", at_revision: 7 } })).phase, "BLOCKED");
  assert.equal(projectOperationalView(state({ dispatches: {
    d1: { wu_id: "WU-01", status: "ambiguous", expected_agent: "harness-builder" },
  } })).next_action, "INSPECT_EXISTING_DISPATCH_ONCE");
  assert.equal(projectOperationalView(state({ budget: { total_seconds: 12, used_seconds: 12, reserved_seconds: 0 } })).phase, "BLOCKED");
  assert.equal(projectOperationalView(state({ completed: true })).phase, "DONE");
  assert.equal(projectOperationalView(state({ mandate: null })).next_action, "REQUIRE_APPROVED_EPIC");
});

test("full reservation does not block an already running child; unknown owner fails closed", () => {
  const b = projectOperationalView(state({
    budget: { total_seconds: 100, used_seconds: 10, reserved_seconds: 90 },
    dispatches: { d: { wu_id: "WU-01", expected_agent: "harness-builder",
      status: "launched", session_id: "child" } },
  }));
  assert.equal(b.phase, "BUILDING");
  assert.equal(b.budget_remaining_seconds, 0);
  const legacy = projectOperationalView(state({
    dispatches: { d: { wu_id: "WU-01", status: "pending_launch" } },
  }));
  assert.equal(legacy.next_action, "INSPECT_EXISTING_DISPATCH_ONCE");
});

test("operational_status integrates as a read-only controller action", async () => {
  const root = await mkdtemp(join(tmpdir(), "operational-view-"));
  try {
    const init = await runExecutionController(root,
      { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 50 });
    const result = await runExecutionController(root,
      { action: "operational_status", execution_id: "E1", session_id: "ses-1" });
    assert.equal(result.action, "operational_status");
    assert.equal(result.revision, init.revision);
    assert.equal(result.phase, "BLOCKED"); // Probe mandate is not approved Epic authority.
    assert.equal(result.next_action, "REQUIRE_APPROVED_EPIC");
    assert.equal(result.budget_remaining_seconds, 50);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reconciled builder without candidate must not be dispatched again", () => {
  const x = projectOperationalView(state({ dispatches: {
    d: { wu_id: "WU-01", expected_agent: "harness-builder", status: "result_reconciled" },
  } }));
  assert.equal(x.phase, "BUILDING");
  assert.equal(x.next_action, "INSPECT_BUILDER_RESULT_BEFORE_RELAUNCH");
});
