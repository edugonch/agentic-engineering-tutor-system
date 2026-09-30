import test from "node:test"
import assert from "node:assert/strict"
import {
  DISPATCH_STATUS,
  RESERVATION_STATUS,
  TERMINAL_DISPATCH_STATUSES,
  OPERATION_TYPES,
} from "../../src/execution/constants.js"

test("DISPATCH_STATUS exposes the full Phase 2 lifecycle with distinct values", () => {
  assert.deepEqual(DISPATCH_STATUS, {
    RESERVED: "reserved",
    PENDING_LAUNCH: "pending_launch",
    LAUNCHED: "launched",
    FINISHED: "finished",
    RESULT_RECONCILED: "result_reconciled",
    RELEASED: "released",
    AMBIGUOUS: "ambiguous",
  })
  // No two statuses may silently alias; the launch-boundary names must stay
  // distinguishable, or recovery classification becomes ambiguous.
  const values = Object.values(DISPATCH_STATUS)
  assert.equal(new Set(values).size, values.length)
})

test("RESERVATION_STATUS is the three-value reservation sub-state", () => {
  assert.deepEqual(RESERVATION_STATUS, {
    RESERVED: "reserved",
    RELEASED: "released",
    CONSUMED: "consumed",
  })
  const values = Object.values(RESERVATION_STATUS)
  assert.equal(new Set(values).size, values.length)
})

test("the launch-boundary names carry distinct meanings", () => {
  // PENDING_LAUNCH ≠ LAUNCHED: before/during the boundary vs confirmed+identity.
  assert.notEqual(DISPATCH_STATUS.PENDING_LAUNCH, DISPATCH_STATUS.LAUNCHED)
  // LAUNCHED ≠ AMBIGUOUS: identity known vs side effect possible, identity unknown.
  assert.notEqual(DISPATCH_STATUS.LAUNCHED, DISPATCH_STATUS.AMBIGUOUS)
  // FINISHED ≠ RESULT_RECONCILED: terminated vs durably incorporated.
  assert.notEqual(DISPATCH_STATUS.FINISHED, DISPATCH_STATUS.RESULT_RECONCILED)
  // RESERVED ≠ RELEASED: held slice vs returned slice (dispatch level).
  assert.notEqual(DISPATCH_STATUS.RESERVED, DISPATCH_STATUS.RELEASED)
})

test("TERMINAL_DISPATCH_STATUSES are exactly the absorbing statuses", () => {
  // AMBIGUOUS is terminal for any auto-launch/retry; RESULT_RECONCILED and
  // RELEASED are absorbing too. Pre-terminal statuses must NOT be terminal.
  assert.deepEqual(
    [...TERMINAL_DISPATCH_STATUSES].sort(),
    [DISPATCH_STATUS.RESULT_RECONCILED, DISPATCH_STATUS.RELEASED, DISPATCH_STATUS.AMBIGUOUS].sort(),
  )
  for (const preTerminal of [DISPATCH_STATUS.RESERVED, DISPATCH_STATUS.PENDING_LAUNCH, DISPATCH_STATUS.LAUNCHED, DISPATCH_STATUS.FINISHED]) {
    assert.equal(TERMINAL_DISPATCH_STATUSES.has(preTerminal), false)
  }
  assert.equal(TERMINAL_DISPATCH_STATUSES.has(DISPATCH_STATUS.AMBIGUOUS), true)
})

test("OPERATION_TYPES includes the Phase 2 dispatch operations and stays unique", () => {
  assert.ok(OPERATION_TYPES.includes("DISPATCH_RELEASE"))
  assert.ok(OPERATION_TYPES.includes("DISPATCH_MARK_AMBIGUOUS"))
  assert.ok(OPERATION_TYPES.includes("DISPATCH_RECONCILE"))
  // Typed vocab must not contain duplicate verbs.
  assert.equal(new Set(OPERATION_TYPES).size, OPERATION_TYPES.length)
})
