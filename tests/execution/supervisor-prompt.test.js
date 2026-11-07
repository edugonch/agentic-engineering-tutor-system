import test from "node:test"
import assert from "node:assert/strict"
import { composeSupervisorPrompt } from "../../src/execution/supervisor-prompt.js"

const execution = "E-1"
const normal = () => ({
  wu: { wu_id: "W1", completed: false },
  mandate: { authority_kind: "OWNER_APPROVED_EPIC", wu_sequence: ["W1", "W2"], merge_policy: "governed_auto" },
  activated_wu_ids: ["W1"], candidates: {}, reviews: {}, dispatches: {},
  budget: { total_seconds: 100, used_seconds: 0, reserved_seconds: 0 },
})

test("compact supervisor prompt preserves mandatory gating for four modes", () => {
  const ordinary = composeSupervisorPrompt({ execution, state: normal(), unsettled: false })
  assert.match(ordinary, /Continue execution E-1 from operational_status first/)
  assert.match(ordinary, /LAUNCH_ONE_BUILDER/)
  assert.match(ordinary, /Never invent PASS/)
  assert.match(ordinary, /owner authority/)
  assert.ok(ordinary.length < 850)
  const tooling = composeSupervisorPrompt({ execution, state: {
    ...normal(), blocker: { class: "BLOCKED_TOOLING", at_revision: 12 },
  }, toolingTriage: true })
  assert.match(tooling, /One-time tooling diagnosis/)
  assert.match(tooling, /harness_retry_blocked_verification/)
  assert.match(tooling, /Never start a new WU, reserve or launch a dispatch/)
  const contract = composeSupervisorPrompt({ execution, state: {
    ...normal(), blocker: { class: "BLOCKED_AUTHORITY", at_revision: 19 },
  }, contractTriage: true })
  assert.match(contract, /derive_and_stage_next_wu_contract/)
  assert.match(contract, /frozen DRAFT/)
  const scope = composeSupervisorPrompt({ execution, state: {
    ...normal(), blocker: { class: "BLOCKED_SCOPE", at_revision: 20 },
  }, scopeTriage: true })
  assert.match(scope, /inspect_scope_worktree/)
  assert.match(scope, /reconcile_stale_worktree_scope/)
})

test("remote waits and unsettled dispatches direct observation and never imply success", () => {
  const state = normal()
  state.dispatches.d = { wu_id: "W1", status: "launched", expected_agent: "harness-builder" }
  let msg = composeSupervisorPrompt({ execution, state, unsettled: true })
  assert.match(msg, /Inspect\/recover the existing dispatch before any new work/)
  state.external_wait = {
    operation: "merge:candidate", next_retry_at: new Date().toISOString(),
  }
  msg = composeSupervisorPrompt({ execution, state, unsettled: true })
  assert.match(msg, /external wait is due/)
  assert.doesNotMatch(msg, /PASS reviewed/)
})
