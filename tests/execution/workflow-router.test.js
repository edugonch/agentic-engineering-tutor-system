import test from "node:test"
import assert from "node:assert/strict"
import { routeExecution, classifyContinuation, hasPendingSupervisorDispatch } from "../../src/execution/workflow-router.js"
import { projectOperationalView } from "../../src/execution/operational-view.js"
import { executionProgress, supervisorProgress } from "../../src/execution/progress.js"
import { stableHash } from "../../src/execution/serialize.js"

const base = () => ({
  execution_id: "execution-1", revision: 20, completed: false, blocker: null,
  mandate: { mandate_id: "M", authority_kind: "OWNER_APPROVED_EPIC",
    wu_sequence: ["W1", "W2"], merge_policy: "governed_auto" },
  wu: { wu_id: "W1", completed: false }, activated_wu_ids: ["W1"],
  dispatches: {}, candidates: {}, reviews: {}, review_history: {}, ci_evidence: {},
  budget: { total_seconds: 1000, used_seconds: 200, reserved_seconds: 0 },
})
const dispatch = (status, agent = "harness-builder") =>
  ({ status, wu_id: "W1", expected_agent: agent, session_id: "ses_child" })
const withCandidate = s => ({
  ...s, candidates: { C1: { wu_id: "W1", tree_hash: "abc" } },
})
const scenarios = [
  ["new WU", s => s, "BUILDING", "LAUNCH_ONE_BUILDER"],
  ["claimed builder", s => ({ ...s, dispatches: { d: dispatch("launched") } }), "BUILDING", "AWAIT_EXISTING_BUILDER"],
  ["ready review", s => ({ ...s, dispatches: { d: dispatch("launched", "harness-reviewer") } }), "REVIEWING", "AWAIT_INDEPENDENT_REVIEW"],
  ["pending launch", s => ({ ...s, dispatches: { d: dispatch("pending_launch") } }), "BUILDING", "AWAIT_EXISTING_BUILDER"],
  ["finished builder", s => ({ ...s, dispatches: { d: dispatch("finished") } }), "BLOCKED", "RECONCILE_FINISHED_DISPATCH"],
  ["ambiguous builder", s => ({ ...s, dispatches: { d: dispatch("ambiguous") } }), "BLOCKED", "INSPECT_EXISTING_DISPATCH_ONCE"],
  ["fenced abandoned", s => ({ ...s, dispatches: { d: dispatch("abandoned") } }), "BLOCKED", "INSPECT_EXISTING_DISPATCH_ONCE"],
  ["reconciled builder", s => ({ ...s, dispatches: { d: dispatch("result_reconciled") } }), "BUILDING", "INSPECT_BUILDER_RESULT_BEFORE_RELAUNCH"],
  ["frozen candidate", s => withCandidate(s), "VERIFYING", "VERIFY_THEN_INDEPENDENT_REVIEW"],
  ["changes required", s => ({ ...withCandidate(s), reviews: { C1: { verdict: "CHANGES_REQUIRED" } } }), "REPAIRING", "REPAIR_SAME_WU"],
  ["approved merge", s => ({ ...withCandidate(s), reviews: { C1: { verdict: "PASS" } } }), "MERGING", "APPLY_GOVERNED_MERGE_GATES"],
  ["verified merge", s => ({ ...withCandidate(s), reviews: { C1: { verdict: "PASS" } }, merge: { status: "VERIFIED", candidate_id: "C1" } }), "MERGING", "COMPLETE_WU"],
  ["tooling blocker", s => ({ ...s, blocker: { class: "BLOCKED_TOOLING", at_revision: 8 } }), "BLOCKED", "DIAGNOSE_ONCE_OR_STOP"],
  ["time estimate exceeded", s => ({ ...s, budget: { total_seconds: 200, used_seconds: 220, reserved_seconds: 0 } }), "BUILDING", "LAUNCH_ONE_BUILDER"],
  ["completed WU", s => ({ ...s, wu: { wu_id: "W1", completed: true } }), "READY", "ACTIVATE_NEXT_APPROVED_WU"],
  ["completed Epic", s => ({ ...s, completed: true }), "DONE", "NONE"],
]
for (const [name, apply, phase, action] of scenarios) {
  test(`router preserves external next_action for ${name}`, () => {
    const s = apply(base())
    const frozen = structuredClone(s)
    const route = routeExecution(s)
    const view = projectOperationalView(s)
    assert.equal(route.phase, phase)
    assert.equal(route.nextAction, action)
    assert.equal(view.phase, phase)
    assert.equal(view.next_action, action)
    assert.deepEqual(s, frozen, "read-only routing must not change event-projected state")
  })
}

test("post-review repair preserves journal temporal ordering and does not relaunch", () => {
  const s = { ...withCandidate(base()),
    reviews: { C1: { verdict: "CHANGES_REQUIRED" } },
    dispatches: { repair: dispatch("result_reconciled") },
  }
  const events = [
    { sequence: 21, operation_type: "RECORD_REVIEW", body: { candidate_id: "C1" } },
    { sequence: 22, operation_type: "DISPATCH_RECONCILE", body: { dispatch_id: "repair" } },
  ]
  assert.equal(routeExecution(s, { events }).nextAction, "INSPECT_REPAIR_RESULT_BEFORE_RELAUNCH")
  assert.equal(projectOperationalView(s, { events }).next_action, "INSPECT_REPAIR_RESULT_BEFORE_RELAUNCH")
  assert.equal(routeExecution(s, { events: events.reverse() }).nextAction, "INSPECT_REPAIR_RESULT_BEFORE_RELAUNCH")
})

test("supervisor dispatch classifier retains historical pending vs finished distinction", () => {
  for (const status of ["reserved", "pending_launch", "launched", "abandoned", "ambiguous"]) {
    assert.equal(hasPendingSupervisorDispatch({ dispatches: { x: dispatch(status) } }), true, status)
  }
  for (const status of ["finished", "released", "result_reconciled", "abandoned_reconciled"]) {
    assert.equal(hasPendingSupervisorDispatch({ dispatches: { x: dispatch(status) } }), false, status)
  }
})

test("supervisor progress hash and tooling triage are unchanged by route extraction", () => {
  const s = base()
  assert.equal(classifyContinuation(s).mode, "ORDINARY")
  assert.equal(supervisorProgress(s), executionProgress(s))
  s.blocker = { class: "BLOCKED_TOOLING", at_revision: 12 }
  assert.equal(classifyContinuation(s).mode, "TOOLING_TRIAGE")
  const oldStyle = stableHash({ phase: "TOOLING_TRIAGE",
    progress: executionProgress(s), blocked_at_revision: 12 })
  assert.equal(supervisorProgress(s), oldStyle)
  s.blocker = { class: "BLOCKED_AUTHORITY", at_revision: 13 }
  assert.equal(classifyContinuation(s).mode, "ORDINARY")
  assert.equal(supervisorProgress(s), executionProgress(s))
})
