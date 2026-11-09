import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { applyEvent, initialState } from "../../src/execution/state.js"

// These tests replace the withdrawn "WU budget amendment" execution policy.
// Old event types are still readable, but duration is now observational only.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "time-estimate-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const controller = await createExecutionController({ dir: join(root, ".harness/execution/controller/E1") })
  const commit = async (type, body) => {
    const lease = await controller.acquire("owner")
    const { state } = await controller.snapshot()
    return controller.commit({ operation_id: `time-${state.revision}`, operation_type: type, body }, {
      holder_session_id: "owner", expected_revision: state.revision, lease_fencing_token: lease.fencing_token,
    })
  }
  await commit("MANDATE_APPROVE", { mandate_id: "M1", execution_id: "E1:exec", max_wus: 2, total_seconds: 100 })
  await commit("WU_ACTIVATE", { mandate_id: "M1", wu_id: "WU063", contract: { active_seconds: 10 } })
  return { controller, commit }
}

test("ALFRAN regression: WU and Epic durations can both overrun with no budget authority", async t => {
  const f = await fixture(t)
  await f.commit("PHASE_START", { phase: "ACTIVE", started_at: 0 })
  await f.commit("PHASE_END", { ended_at: 150 })
  await f.commit("DISPATCH_RESERVE", { dispatch_id: "continue", reserved_seconds: 200 })
  const s = (await f.controller.snapshot()).state
  assert.equal(s.budget.used_seconds, 150)
  assert.equal(s.budget.reserved_seconds, 200)
  assert.equal(s.budget.total_seconds, 100)
  assert.equal(s.blocker, null)
  assert.equal((await f.controller.budget()).enforced, false)
  await assert.rejects(f.commit("BLOCK", { class: "BUDGET_EXHAUSTED", reason: "WU estimate exceeded" }), /TIME_ESTIMATE_NOT_A_BLOCKER/)
  await f.commit("DISPATCH_RELEASE", { dispatch_id: "continue" })
  assert.equal((await f.controller.snapshot()).state.blocker, null)
})

function legacyState() {
  const state = initialState()
  state.revision = 19
  state.execution_id = "E1:exec"
  state.mandate = { mandate_id: "M1", authority_kind: "OWNER_APPROVED_EPIC" }
  state.wu = { wu_id: "WU063", completed: false, contract: { active_seconds: 10 } }
  state.budget.total_seconds = 100
  state.budget.used_seconds = 150
  state.blocker = { class: "BUDGET_EXHAUSTED", reason: "historical estimate exhausted", at_revision: 18, budget_reason: "epic_exhausted" }
  return state
}
function clear(s, blocked_at_revision = 18) {
  return applyEvent(s, { operation_type: "CLEAR_BLOCKER",
    body: { blocker_class: "BUDGET_EXHAUSTED", blocked_at_revision,
      resolution: "Duration estimates do not require new authority" }, next_revision: s.revision + 1 })
}

test("historical budget stop retires with an exact audited event and preserves accounting", () => {
  const original = legacyState()
  const current = clear(original)
  assert.equal(current.blocker, null)
  assert.equal(current.last_blocker_resolution.class, "BUDGET_EXHAUSTED")
  assert.equal(current.last_blocker_resolution.blocked_at_revision, 18)
  assert.equal(current.budget.used_seconds, 150)
  assert.equal(current.budget.total_seconds, 100)
  assert.equal(current.wu.wu_id, "WU063")
  assert.equal(current.revision, 20)
})

test("historical time stop cannot be retired with wrong revision or unsettled side effects", () => {
  const state = legacyState()
  assert.throws(() => clear(structuredClone(state), 16), /target does not match/)
  const withDispatch = structuredClone(state)
  withDispatch.dispatches.live = { status: "launched", reservation_status: "reserved", reserved_seconds: 10 }
  withDispatch.budget.reserved_seconds = 10
  assert.throws(() => clear(withDispatch), /TIME_ESTIMATE_RECOVERY_UNSETTLED/)
  const withPhase = structuredClone(state)
  withPhase.budget.active_phase = "ACTIVE"
  assert.throws(() => clear(withPhase), /TIME_ESTIMATE_RECOVERY_UNSETTLED/)
  const withWait = structuredClone(state)
  withWait.external_wait = { wait_id: "remote" }
  assert.throws(() => clear(withWait), /TIME_ESTIMATE_RECOVERY_UNSETTLED/)
})

test("real permission and authority blockers remain non-clearable", () => {
  for (const cls of ["BLOCKED_PERMISSION", "BLOCKED_SECURITY", "BLOCKED_SCOPE", "BLOCKED_AUTHORITY"]) {
    const state = legacyState()
    state.blocker.class = cls
    assert.throws(() => applyEvent(state, {
      operation_type: "CLEAR_BLOCKER", body: { blocker_class: cls, blocked_at_revision: 18, resolution: "guess" },
      next_revision: 20,
    }), /non-recoverable/)
  }
})
