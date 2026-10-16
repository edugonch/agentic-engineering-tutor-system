import test from "node:test"
import assert from "node:assert/strict"
import { inspectAuthorityGap } from "../src/execution/authority-triage.js"

test("unstructured active-WU authority stop is never automatically resolved", () => {
  const gap = inspectAuthorityGap({ wu: { wu_id: "E05-04-E", completed: false },
    blocker: { class: "BLOCKED_AUTHORITY", at_revision: 458,
      reason: "Appointment state tokens and guest confirmation policy unresolved" } })
  assert.equal(gap.status, "UNSTRUCTURED_AUTHORITY_STOP")
  assert.equal(gap.can_auto_resolve, false)
  assert.equal(gap.blocked_at_revision, 458)
})

test("owner business-policy and safety domains override technical text heuristics", () => {
  for (const domain of ["product", "scope", "security", "permission", "budget"]) {
    const gap = inspectAuthorityGap({ blocker: {
      class: "BLOCKED_AUTHORITY", at_revision: 30,
      reason: "missing execution_contract",
      authority_question: { domain, decision: "Determine guest auto-confirm policy",
        source_ref: "PROJECT_STATE.md", why_not_delegated: "Explicit open owner decision" },
    } })
    assert.equal(gap.status, "BUSINESS_OR_SAFETY_AUTHORITY_REQUIRED")
    assert.equal(gap.can_auto_resolve, false)
  }
})

test("exact mandate JIT recovery never clears a real blocker", () => {
  const state = { wu: { completed: true },
    time_policy: { mode: "WU_PLANNING_ESTIMATES" },
    blocker: { class: "BLOCKED_AUTHORITY", reason: "no executable contract",
      at_revision: 11 } }
  const gap = inspectAuthorityGap(state)
  assert.equal(gap.status, "TECHNICAL_CONTRACT_RECOVERY")
  assert.equal(gap.can_auto_resolve, false)
  assert.equal(inspectAuthorityGap({ ...state, time_policy: null }).status, "TIME_POLICY_REQUIRED")
  assert.equal(inspectAuthorityGap({ ...state, blocker: { class: "BLOCKED_SECURITY" } }).status, "OTHER_BLOCKER")
  assert.equal(inspectAuthorityGap({ ...state, blocker: null }).status, "NO_AUTHORITY_BLOCKER")
})
