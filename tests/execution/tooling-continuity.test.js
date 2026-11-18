import test from "node:test"
import assert from "node:assert/strict"
import {
  inspectToolingContinuity,
  MAX_TOOLING_CONTINUATIONS_WITHOUT_PRODUCT_PROGRESS,
} from "../../src/execution/tooling-continuity.js"

const state = () => ({
  mandate: { authority_kind: "OWNER_APPROVED_EPIC" },
  completed: false,
  wu: { wu_id: "E05-28", completed: false, batch: { wu_ids: Array.from({length:10}, (_, i) => "E05-" + (28+i)) } },
  blocker: { class: "BLOCKED_TOOLING", at_revision: 2819, reason: "suspected restart" },
  budget: { active_phase: null },
  verification_phase: null,
  external_wait: null,
  dispatches: {
    "build-1": { wu_id: "E05-28", expected_agent: "harness-builder",
      status: "result_reconciled", session_id: "ses_child_1" },
  },
})

test("real settled builder in a ten-WU batch can resume despite a historical tooling stop", () => {
  const current = state()
  const answer = inspectToolingContinuity(current)
  assert.equal(answer.allowed, true)
  assert.equal(answer.blocker_revision, 2819)
  assert.equal(answer.prior_resumes, 0)
  assert.equal(current.blocker.class, "BLOCKED_TOOLING", "read-only classification must not clear any state")
})

test("ambiguous and running children cannot be cleared or relaunched", () => {
  for (const status of ["reserved", "pending_launch", "launched", "finished", "abandoned", "ambiguous"]) {
    const current = state()
    current.dispatches["build-2"] = { wu_id: "E05-28", expected_agent: "harness-builder", status, session_id: "ses_child_2" }
    const result = inspectToolingContinuity(current)
    assert.equal(result.allowed, false, status)
    assert.equal(result.reason, "UNSETTLED_DISPATCH")
  }
})

test("generic tooling notes, setup failures and unverifiable legacy blockers are not automatically cleared", () => {
  const current = state()
  current.dispatches = {}
  assert.equal(inspectToolingContinuity(current).reason, "NO_SETTLED_WORKER_ATTEMPT_PROVEN")
  current.dispatches.orphan = { wu_id: "E05-28", expected_agent: "harness-builder", status: "released" }
  assert.equal(inspectToolingContinuity(current).reason, "NO_SETTLED_WORKER_ATTEMPT_PROVEN")
  current.dispatches.orphan.launch_call_id = "call_proven"
  assert.equal(inspectToolingContinuity(current).allowed, true)
})

test("an active verification, wait, phase, wrong authority or finished WU cannot auto-clear", () => {
  for (const change of [
    s => s.verification_phase = { phase: "RUNNING" },
    s => s.external_wait = { kind: "REMOTE_TRANSIENT" },
    s => s.budget.active_phase = "ACTIVE",
    s => s.mandate.authority_kind = "UNAPPROVED",
    s => s.wu.completed = true,
    s => s.completed = true,
    s => s.blocker.class = "BLOCKED_SECURITY",
  ]) {
    const current = state()
    change(current)
    assert.equal(inspectToolingContinuity(current).allowed, false)
  }
})

test("two automatic clearances without product progress prevent repeated costly failures", () => {
  const current = state()
  const events = [ { sequence: 1, operation_type: "WU_ACTIVATE" } ]
  for (let i = 0; i < MAX_TOOLING_CONTINUATIONS_WITHOUT_PRODUCT_PROGRESS; i++)
    events.push({ sequence: 2 + i, operation_type: "CLEAR_BLOCKER",
      body: { blocker_class: "BLOCKED_TOOLING",
        recovery_evidence: { kind: "SETTLED_TOOLING_CONTINUATION" } } })
  assert.equal(inspectToolingContinuity(current, events).reason,
    "REPEATED_INTERRUPTION_WITHOUT_PRODUCT_PROGRESS")
  events.push({ sequence: 10, operation_type: "FREEZE_CANDIDATE" })
  assert.equal(inspectToolingContinuity(current, events).allowed, true)
  // Ordinary manual clearances cannot fabricate an auto-resume history.
  assert.equal(inspectToolingContinuity(current, [{ sequence: 1,
    operation_type: "CLEAR_BLOCKER",
    body: { blocker_class: "BLOCKED_TOOLING", resolution: "human verified" } }]).allowed, true)
})
