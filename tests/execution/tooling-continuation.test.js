import test from "node:test"
import assert from "node:assert/strict"
import { initialState, applyEvent } from "../../src/execution/state.js"
import {
  inspectSettledToolingContinuation, settledToolingClearBody,
  MAX_SETTLED_TOOLING_CONTINUATIONS_PER_WU,
} from "../../src/execution/tooling-continuation.js"

const NOW = Date.parse("2026-11-17T20:00:00.000Z")
const BATCH = Array.from({ length: 10 }, (_, i) => `E05-${28+i}-E`)
function fixture() {
  const state = initialState()
  state.revision = 2819
  state.mandate = { authority_kind: "OWNER_APPROVED_EPIC", wu_sequence: BATCH }
  state.wu = { wu_id: BATCH[0], completed: false, batch: { wu_ids: BATCH, batch_hash: "frozen" } }
  state.blocker = { class: "BLOCKED_TOOLING", at_revision: 2819,
    reason: "Two interrupted builder launches after a client disconnection" }
  state.dispatches = {
    first: { wu_id: BATCH[0], expected_agent: "harness-builder",
      status: "released", reservation_status: "released", released_from_status: "pending_launch", released_at_revision: 2816 },
    second: { wu_id: BATCH[0], expected_agent: "harness-builder",
      status: "released", reservation_status: "released", released_from_status: "pending_launch", released_at_revision: 2818 },
  }
  return state
}
const inspect = state => inspectSettledToolingContinuation(state, {
  nowMs: NOW, runtimeLoadedAtMs: NOW - 10 * 60 * 1000,
})
function clear(state, body) {
  return applyEvent(state, {
    operation_type: "CLEAR_BLOCKER", previous_revision: state.revision,
    next_revision: state.revision + 1, body,
  })
}

test("EPIC-05 ten-WU batch: settled interrupted launches permit one safe audited continuation", () => {
  const state = fixture()
  const plan = inspect(state)
  assert.equal(plan.eligible, true)
  assert.deepEqual(plan.dispatch_ids, ["first", "second"])
  assert.equal(plan.wu_id, BATCH[0])
  const body = settledToolingClearBody(state, plan)
  const resumed = clear(state, body)
  assert.equal(resumed.blocker, null)
  assert.equal(resumed.tooling_continuations[BATCH[0]], 1)
  assert.deepEqual(resumed.wu.batch.wu_ids, BATCH)
  assert.deepEqual(resumed.dispatches, state.dispatches)
  assert.deepEqual(resumed.last_blocker_resolution.recovery_evidence.dispatch_ids, ["first", "second"])
  assert.equal(resumed.revision, 2820)
  assert.equal(state.blocker.at_revision, 2819, "no historical journal rewrite")
})

test("safety: ambiguous, active and unverified launch effects never auto-clear a tooling blocker", () => {
  for (const status of ["reserved", "pending_launch", "launched", "finished", "ambiguous", "abandoned"]) {
    const state = fixture()
    state.dispatches.unsettled = { wu_id: BATCH[0], expected_agent: "harness-builder", status }
    assert.equal(inspect(state).reason, "UNSETTLED_DISPATCH", status)
    assert.equal(inspect(state).eligible, false)
  }
  const active = fixture()
  active.verification_phase = { operation_id: "check-live" }
  assert.equal(inspect(active).reason, "PHASE_OR_EXTERNAL_EFFECT_UNSETTLED")
  const external = fixture()
  external.external_wait = { kind: "REMOTE_TRANSIENT" }
  assert.equal(inspect(external).eligible, false)
  const security = fixture()
  security.blocker.class = "BLOCKED_SECURITY"
  assert.equal(inspect(security).eligible, false)
  const noInterrupted = fixture()
  noInterrupted.dispatches.first.status = "result_reconciled"
  noInterrupted.dispatches.second.status = "result_reconciled"
  assert.equal(inspect(noInterrupted).reason, "NO_RECENT_SETTLED_INTERRUPTION")
  const stale = fixture()
  for (const d of Object.values(stale.dispatches)) {
    d.status = "abandoned_reconciled"
    d.reconciled = { at_revision: 2700 }
    d.fence = { timestamp: new Date(NOW - 600000).toISOString() }
  }
  assert.equal(inspect(stale).reason, "NO_RECENT_SETTLED_INTERRUPTION")
})

test("safety: no bootstrap evidence or active orphan cooldown grants no automatic recovery", () => {
  const state = fixture()
  assert.equal(inspectSettledToolingContinuation(state).reason, "RUNTIME_OBSERVATION_UNAVAILABLE")
  state.dispatches.first.status = "abandoned_reconciled"
  state.dispatches.first.reconciled = { at_revision: 2816 }
  state.dispatches.first.fence = { timestamp: new Date(NOW - 1000).toISOString() }
  state.dispatches.second.status = "abandoned_reconciled"
  state.dispatches.second.reconciled = { at_revision: 2818 }
  state.dispatches.second.fence = { timestamp: new Date(NOW - 1000).toISOString() }
  assert.equal(inspect(state).reason, "RUNTIME_COOLDOWN_ACTIVE")
})

test("fencing: fabricated evidence, stale WU or changed dispatch set cannot clear a blocker", () => {
  const state = fixture(), plan = inspect(state)
  const body = settledToolingClearBody(state, plan)
  assert.throws(() => clear(state, { ...body, recovery_evidence: {
    ...body.recovery_evidence, dispatch_ids: ["first"] } }), /SETTLED_TOOLING_RECOVERY_EVIDENCE_MISMATCH/)
  assert.throws(() => clear(state, { ...body, recovery_evidence: {
    ...body.recovery_evidence, attempt: 2 } }), /SETTLED_TOOLING_RECOVERY_EVIDENCE_MISMATCH/)
  const current = fixture()
  current.wu.wu_id = BATCH[1]
  assert.throws(() => clear(current, body), /SETTLED_TOOLING_RECOVERY_EVIDENCE_MISMATCH/)
  const unsettled = fixture()
  unsettled.dispatches.second.status = "launched"
  assert.throws(() => clear(unsettled, body), /SETTLED_TOOLING_RECOVERY_EVIDENCE_MISMATCH/)
})

test("bounded cost: a persistent failure does not cause indefinite automatic clear/relaunch", () => {
  const state = fixture()
  state.tooling_continuations = { [BATCH[0]]: MAX_SETTLED_TOOLING_CONTINUATIONS_PER_WU }
  assert.equal(inspect(state).reason, "RETRY_CAP_REACHED")
  assert.equal(inspect(state).eligible, false)
  const falseSetup = fixture()
  falseSetup.blocker.reason = "npm ci setup timeout on frozen check"
  assert.equal(inspect(falseSetup).reason, "NOT_A_SETTLED_LAUNCH_INCIDENT")
})

test("unrelated old released dispatch cannot clear an independent tooling incident", () => {
  const state = fixture()
  state.dispatches.first.released_at_revision = 2700
  state.dispatches.second.released_at_revision = 2701
  assert.equal(inspect(state).reason, "NO_RECENT_SETTLED_INTERRUPTION")
  assert.equal(inspect(state).eligible, false)
  // An unproven release revision also cannot become authority.
  delete state.dispatches.first.released_at_revision
  delete state.dispatches.second.released_at_revision
  assert.equal(inspect(state).reason, "NO_RECENT_SETTLED_INTERRUPTION")
})

test("a stale release plus one exact recent release provides only the recent evidence", () => {
  const state = fixture()
  state.dispatches.first.released_at_revision = 2700
  const plan = inspect(state)
  assert.equal(plan.eligible, true)
  assert.deepEqual(plan.dispatch_ids, ["second"])
})

test("release provenance is reconstructed on replay; no backfill or mutable state file", () => {
  let state = initialState()
  state.mandate = { mandate_id: "M", authority_kind: "OWNER_APPROVED_EPIC" }
  state.wu = { wu_id: "WU1", completed: false }
  state.budget = { total_seconds: 100, used_seconds: 0, reserved_seconds: 0 }
  state.revision = 1
  const next = (operation_type, body) => {
    state = applyEvent(state, {
      operation_type, body,
      previous_revision: state.revision,
      next_revision: state.revision + 1,
    })
  }
  next("DISPATCH_RESERVE", { dispatch_id: "unclaimed", reserved_seconds: 0 })
  next("DISPATCH_RELEASE", { dispatch_id: "unclaimed" })
  assert.equal(state.dispatches.unclaimed.released_at_revision, 3)
  assert.equal(state.dispatches.unclaimed.released_from_status, "reserved")
  assert.equal(state.dispatches.unclaimed.status, "released")
})

test("an unprepared reservation released recently cannot masquerade as a failed worker launch", () => {
  const state = fixture()
  state.dispatches.first.released_from_status = "reserved"
  state.dispatches.second.released_from_status = "reserved"
  assert.equal(inspect(state).eligible, false)
  assert.equal(inspect(state).reason, "NO_RECENT_SETTLED_INTERRUPTION")
})

test("a genuinely prepared, never-claimed launch release keeps precise replay provenance", () => {
  let state = initialState()
  state.revision = 10
  state.mandate = { mandate_id: "M", authority_kind: "OWNER_APPROVED_EPIC" }
  state.wu = { wu_id: "WU1", completed: false }
  state.budget = { total_seconds: 100, used_seconds: 0, reserved_seconds: 0 }
  const next = (operation_type, body) => {
    state = applyEvent(state, {
      operation_type, body,
      previous_revision: state.revision, next_revision: state.revision + 1,
    })
  }
  next("DISPATCH_RESERVE", { dispatch_id: "attempted", reserved_seconds: 0 })
  next("DISPATCH_PREPARE", { dispatch_id: "attempted", expected_agent: "harness-builder" })
  next("DISPATCH_RELEASE", { dispatch_id: "attempted" })
  assert.equal(state.dispatches.attempted.released_at_revision, 13)
  assert.equal(state.dispatches.attempted.released_from_status, "pending_launch")
  assert.equal(state.dispatches.attempted.launch_call_id, undefined)
})
