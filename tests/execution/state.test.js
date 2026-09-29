import test from "node:test"
import assert from "node:assert/strict"
import { applyEvent, initialState, project } from "../../src/execution/state.js"
import { stableHash } from "../../src/execution/serialize.js"

const ev = (operation_type, body, previous_revision, next_revision, extra = {}) => ({
  sequence: next_revision,
  event_id: `e${next_revision}`,
  operation_id: `op-${next_revision}`,
  operation_type,
  operation_hash: stableHash(body),
  body,
  previous_revision,
  next_revision,
  fencing_token: 1,
  timestamp: "t",
  ...extra,
})

test("projects a mandate, JIT WU activation, and billable phase", () => {
  const events = [
    ev("MANDATE_APPROVE", { execution_id: "exec", mandate_id: "M1", mandate_revision: "r0", max_wus: 4, total_seconds: 60 }, 0, 1),
    ev("WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }, 1, 2),
    ev("PHASE_START", { phase: "ACTIVE", started_at: 0 }, 2, 3),
    ev("PHASE_END", { phase: "ACTIVE", ended_at: 100 }, 3, 4),
  ]
  const state = project(events)
  assert.equal(state.execution_id, "exec")
  assert.deepEqual(state.mandate, { mandate_id: "M1", mandate_revision: "r0", max_wus: 4 })
  assert.equal(state.wu.authorization, "AUTHORIZED_BY_MANDATE")
  assert.equal(state.budget.used_seconds, 100)
  assert.equal(state.budget.active_phase, null)
})

test("WAITING phases do not bill", () => {
  const events = [
    ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 4, total_seconds: 60 }, 0, 1),
    ev("PHASE_START", { phase: "WAITING_OWNER", started_at: 0 }, 1, 2),
    ev("PHASE_END", { phase: "WAITING_OWNER", ended_at: 500 }, 2, 3),
  ]
  assert.equal(project(events).budget.used_seconds, 0)
})

test("rejects a torn log whose revisions do not chain", () => {
  const events = [
    ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 4, total_seconds: 60 }, 0, 1),
    ev("CHECKPOINT", { note: "x" }, 3, 4), // previous_revision does not chain
  ]
  assert.throws(() => project(events), /previous_revision/)
})

test("rejects forward execution after a terminal blocker", () => {
  const events = [
    ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 4, total_seconds: 60 }, 0, 1),
    ev("BLOCK", { class: "BLOCKED_PERMISSION", reason: "denied" }, 1, 2),
  ]
  const state = project(events)
  assert.equal(state.blocker.class, "BLOCKED_PERMISSION")
  // budget and checkpoint remain intact through the blocker
  assert.equal(state.budget.used_seconds, 0)
  assert.throws(() => applyEvent(state, ev("DISPATCH_RESERVE", { dispatch_id: "d1" }, 2, 3)), /Forward execution is blocked/)
  assert.throws(() => applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-02", mandate_id: "M1" }, 2, 3)), /Forward execution is blocked/)
  // audit operations are still allowed
  assert.doesNotThrow(() => applyEvent(state, ev("CHECKPOINT", { note: "audit" }, 2, 3)))
})

test("a review cannot accredit a different candidate", () => {
  const events = [
    ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 4, total_seconds: 60 }, 0, 1),
    ev("FREEZE_CANDIDATE", { candidate_id: "A", manifest_hash: "mhA", tree_hash: "thA" }, 1, 2),
    ev("RECORD_REVIEW", { candidate_id: "A", verdict: "PASS", candidate_hashes: { manifest_hash: "mhA", tree_hash: "thA" } }, 2, 3),
  ]
  const state = project(events)
  assert.equal(state.reviews.A.verdict, "PASS")

  const mismatch = [
    ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 4, total_seconds: 60 }, 0, 1),
    ev("FREEZE_CANDIDATE", { candidate_id: "A", manifest_hash: "mhA", tree_hash: "thA" }, 1, 2),
    ev("RECORD_REVIEW", { candidate_id: "A", verdict: "PASS", candidate_hashes: { manifest_hash: "mhA", tree_hash: "thB" } }, 2, 3),
  ]
  assert.throws(() => project(mismatch), /different candidate/)
})

test("initial state has revision 0 and empty projections", () => {
  const s = initialState()
  assert.equal(s.revision, 0)
  assert.equal(s.blocker, null)
  assert.deepEqual(s.dispatches, {})
})
