import test from "node:test"
import assert from "node:assert/strict"
import { applyEvent, project } from "../../src/execution/state.js"
import { stableHash } from "../../src/execution/serialize.js"
import { DISPATCH_STATUS, RESERVATION_STATUS } from "../../src/execution/constants.js"

// Build a well-formed event sequence with chained revisions.
function makeBuilder() {
  let seq = 0
  return (operation_type, body, extra = {}) => {
    seq += 1
    return {
      sequence: seq,
      event_id: `e${seq}`,
      operation_id: `op-${seq}`,
      operation_type,
      operation_hash: stableHash(body),
      body,
      previous_revision: seq - 1,
      next_revision: seq,
      fencing_token: 1,
      timestamp: "t",
      ...extra,
    }
  }
}

// Build the "next" event that a caller would try to apply onto a projected state.
function nextEvent(state, operation_type, body) {
  const seq = state.revision + 1
  return {
    sequence: seq,
    event_id: `e${seq}`,
    operation_id: "op-next",
    operation_type,
    operation_hash: stableHash(body),
    body,
    previous_revision: state.revision,
    next_revision: seq,
    fencing_token: 1,
    timestamp: "t",
  }
}

const MANDATE = { mandate_id: "M1", max_wus: 4, total_seconds: 100 }

// reserve → prepare → launch → finish (the pre-reconcile happy path).
function launchedDispatch(ev, { dispatch_id = "d1", reserved = 10, session_id = "ses-1", result = "ok" } = {}) {
  return [
    ev("DISPATCH_RESERVE", { dispatch_id, reserved_seconds: reserved }),
    ev("DISPATCH_PREPARE", { dispatch_id }),
    ev("DISPATCH_LAUNCH", { dispatch_id, session_id }),
    ev("DISPATCH_FINISH", { dispatch_id, result }),
  ]
}

test("reserve → rebuild from log yields the same reservation", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ev("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 30 })]
  const first = project(events)
  const rebuilt = project(events) // a fresh projection of the same log (crash/rebuild)
  assert.equal(first.budget.reserved_seconds, 30)
  assert.deepEqual(rebuilt.budget, first.budget)
  assert.equal(rebuilt.dispatches.d1.reservation_status, RESERVATION_STATUS.RESERVED)
  assert.equal(rebuilt.dispatches.d1.reserved_seconds, 30)
})

test("two distinct reservations accumulate (double reserve is visible, not merged)", () => {
  const ev = makeBuilder()
  const events = [
    ev("MANDATE_APPROVE", MANDATE),
    ev("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 5 }),
    ev("DISPATCH_RESERVE", { dispatch_id: "d2", reserved_seconds: 7 }),
  ]
  const s = project(events)
  assert.equal(s.budget.reserved_seconds, 12)
  assert.equal(s.dispatches.d1.reserved_seconds, 5)
  assert.equal(s.dispatches.d2.reserved_seconds, 7)
})

test("release returns the reservation exactly once; a second distinct release is rejected", () => {
  const ev = makeBuilder()
  const events = [
    ev("MANDATE_APPROVE", MANDATE),
    ev("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 5 }),
    ev("DISPATCH_RELEASE", { dispatch_id: "d1" }),
  ]
  const s = project(events)
  assert.equal(s.budget.reserved_seconds, 0)
  assert.equal(s.dispatches.d1.status, DISPATCH_STATUS.RELEASED)
  assert.equal(s.dispatches.d1.reservation_status, RESERVATION_STATUS.RELEASED)
  // A second, distinct release event must not discount a second time.
  assert.throws(() => applyEvent(s, nextEvent(s, "DISPATCH_RELEASE", { dispatch_id: "d1" })), /Cannot release/)
})

test("reconcile with actual_consumption < reserved consumes only the reported amount", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ...launchedDispatch(ev, { reserved: 10 }), ev("DISPATCH_RECONCILE", { dispatch_id: "d1", actual_consumption: 4 })]
  const s = project(events)
  assert.equal(s.budget.reserved_seconds, 0)
  assert.equal(s.budget.used_seconds, 4)
  assert.equal(s.dispatches.d1.actual_consumption, 4)
  assert.equal(s.dispatches.d1.reservation_status, RESERVATION_STATUS.CONSUMED)
  assert.equal(s.dispatches.d1.status, DISPATCH_STATUS.RESULT_RECONCILED)
})

test("reconcile with actual_consumption == reserved consumes the full reservation", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ...launchedDispatch(ev, { reserved: 10 }), ev("DISPATCH_RECONCILE", { dispatch_id: "d1", actual_consumption: 10 })]
  const s = project(events)
  assert.equal(s.budget.used_seconds, 10)
  assert.equal(s.budget.reserved_seconds, 0)
})

test("reconcile without actual_consumption consumes the whole reservation (unknown is never zero)", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ...launchedDispatch(ev, { reserved: 10 }), ev("DISPATCH_RECONCILE", { dispatch_id: "d1" })]
  const s = project(events)
  assert.equal(s.budget.used_seconds, 10) // consumed the reservation, not 0
  assert.equal(s.dispatches.d1.actual_consumption, 10)
})

test("reconcile with actual_consumption > reserved fails closed (no silent overrun)", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ...launchedDispatch(ev, { reserved: 10 }), ev("DISPATCH_RECONCILE", { dispatch_id: "d1", actual_consumption: 11 })]
  assert.throws(() => project(events), /exceeds reservation/)
})

test("ambiguous retains the reservation and never zeroes it", () => {
  const ev = makeBuilder()
  const events = [
    ev("MANDATE_APPROVE", MANDATE),
    ev("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 5 }),
    ev("DISPATCH_MARK_AMBIGUOUS", { dispatch_id: "d1" }),
  ]
  const s = project(events)
  assert.equal(s.dispatches.d1.status, DISPATCH_STATUS.AMBIGUOUS)
  assert.equal(s.dispatches.d1.reservation_status, RESERVATION_STATUS.RESERVED)
  assert.equal(s.budget.reserved_seconds, 5) // still held
})

test("ambiguous cannot transition to launch (no auto-relaunch)", () => {
  const ev = makeBuilder()
  const events = [
    ev("MANDATE_APPROVE", MANDATE),
    ev("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 5 }),
    ev("DISPATCH_MARK_AMBIGUOUS", { dispatch_id: "d1" }),
  ]
  const s = project(events)
  assert.throws(() => applyEvent(s, nextEvent(s, "DISPATCH_LAUNCH", { dispatch_id: "d1", session_id: "ses-9" })), /not reserved\/pending/)
})

test("released cannot reconcile", () => {
  const ev = makeBuilder()
  const events = [
    ev("MANDATE_APPROVE", MANDATE),
    ev("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 5 }),
    ev("DISPATCH_RELEASE", { dispatch_id: "d1" }),
  ]
  const s = project(events)
  assert.throws(() => applyEvent(s, nextEvent(s, "DISPATCH_RECONCILE", { dispatch_id: "d1" })), /not finished/)
})

test("result_reconciled cannot reconcile again", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ...launchedDispatch(ev, { reserved: 10 }), ev("DISPATCH_RECONCILE", { dispatch_id: "d1", actual_consumption: 4 })]
  const s = project(events)
  assert.throws(() => applyEvent(s, nextEvent(s, "DISPATCH_RECONCILE", { dispatch_id: "d1", actual_consumption: 4 })), /not finished/)
})

test("replaying the event log reconstructs the exact same budget", () => {
  const ev = makeBuilder()
  const events = [
    ev("MANDATE_APPROVE", MANDATE),
    ev("PHASE_START", { phase: "ACTIVE", started_at: 0 }),
    ev("PHASE_END", { phase: "ACTIVE", ended_at: 40 }),
    ...launchedDispatch(ev, { reserved: 10 }),
    ev("DISPATCH_RECONCILE", { dispatch_id: "d1", actual_consumption: 6 }),
  ]
  const a = project(events)
  const b = project(events)
  assert.deepEqual(a.budget, b.budget)
  assert.equal(a.budget.used_seconds, 46) // 40 phase + 6 consumption
  assert.equal(a.budget.reserved_seconds, 0)
})

test("a negative reservation is rejected", () => {
  const s = project([makeBuilder()("MANDATE_APPROVE", MANDATE)])
  assert.throws(() => applyEvent(s, nextEvent(s, "DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: -1 })), /non-negative/)
})

test("release is forbidden once launched (not a never-launched state)", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ev("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 5 }), ev("DISPATCH_PREPARE", { dispatch_id: "d1" }), ev("DISPATCH_LAUNCH", { dispatch_id: "d1", session_id: "ses-1" })]
  const s = project(events)
  assert.throws(() => applyEvent(s, nextEvent(s, "DISPATCH_RELEASE", { dispatch_id: "d1" })), /never-launched/)
})

test("a claimed launch (launch_call_id set) cannot be released; mark_ambiguous is the path", () => {
  const ev = makeBuilder()
  const events = [
    ev("MANDATE_APPROVE", MANDATE),
    ev("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 5 }),
    ev("DISPATCH_PREPARE", { dispatch_id: "d1" }),
  ]
  const s = project(events)
  // A committed launch_claim sets launch_call_id: the side effect may have
  // occurred even though no session identity was recorded. Release must fail
  // closed rather than treat the outcome as deterministically never-launched.
  s.dispatches.d1.launch_call_id = "call-1"
  assert.throws(
    () => applyEvent(s, nextEvent(s, "DISPATCH_RELEASE", { dispatch_id: "d1" })),
    /launch was claimed|ambiguous/,
  )
  // mark_ambiguous preserves the reservation and is the correct non-releasing path.
  const s2 = applyEvent(s, nextEvent(s, "DISPATCH_MARK_AMBIGUOUS", { dispatch_id: "d1" }))
  assert.equal(s2.dispatches.d1.status, DISPATCH_STATUS.AMBIGUOUS)
  assert.equal(s2.dispatches.d1.reservation_status, RESERVATION_STATUS.RESERVED)
  assert.equal(s2.budget.reserved_seconds, 5) // still held
})

test("mark_ambiguous is forbidden from a launched state", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ev("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 5 }), ev("DISPATCH_PREPARE", { dispatch_id: "d1" }), ev("DISPATCH_LAUNCH", { dispatch_id: "d1", session_id: "ses-1" })]
  const s = project(events)
  assert.throws(() => applyEvent(s, nextEvent(s, "DISPATCH_MARK_AMBIGUOUS", { dispatch_id: "d1" })), /ambiguous from status/)
})

test("reconcile requires FINISHED (not launched)", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ev("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 5 }), ev("DISPATCH_PREPARE", { dispatch_id: "d1" }), ev("DISPATCH_LAUNCH", { dispatch_id: "d1", session_id: "ses-1" })]
  const s = project(events)
  assert.throws(() => applyEvent(s, nextEvent(s, "DISPATCH_RECONCILE", { dispatch_id: "d1" })), /not finished/)
})
