import test from "node:test"
import assert from "node:assert/strict"
import { applyEvent, project } from "../../src/execution/state.js"
import { createTurnGuard, readGuardSettings } from "../../src/turn-guard.js"
import { stableHash } from "../../src/execution/serialize.js"

function makeBuilder() {
  let seq = 0
  return (operation_type, body) => {
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
    }
  }
}

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

const MANDATE = { mandate_id: "M1", max_wus: 8, total_seconds: 1000, merge_policy: "governed_auto", required_ci_checks: ["check-1"] }

test("E2E WU-058: delegation guard default + dispatch recovery + governed merge + complete + next WU", () => {
  // 1. The delegation guard no longer imposes a fixed per-turn ceiling (the
  //    WU-058 false-stop source): a build→review→repair→review flow and beyond
  //    must pass by default.
  const guard = createTurnGuard(readGuardSettings({}))
  for (let i = 0; i < 40; i += 1) {
    assert.doesNotThrow(() => guard.before({ tool: "subagent", sessionID: "governed" }, { args: { description: `work-${i}` } }))
  }

  const ev = makeBuilder()
  let s = project([
    ev("MANDATE_APPROVE", MANDATE),
    ev("WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }),
    // reviewer dispatch prepared, then the subagent launch is rejected before the
    // side effect: no DISPATCH_LAUNCH_CLAIM is written.
    ev("DISPATCH_RESERVE", { dispatch_id: "reviewer-1", reserved_seconds: 10 }),
    ev("DISPATCH_PREPARE", { dispatch_id: "reviewer-1", claim_required: true, expected_agent: "harness-reviewer", prepared_by_session_id: "owner" }),
  ])

  // no claim was written, the reservation is still held
  assert.equal(s.dispatches["reviewer-1"].launch_call_id, undefined)
  assert.equal(s.budget.reserved_seconds, 10)

  // recovery classifies it NEVER_LAUNCHED and release returns the reservation
  s = applyEvent(s, nextEvent(s, "DISPATCH_RELEASE", { dispatch_id: "reviewer-1" }))
  assert.equal(s.budget.reserved_seconds, 0)

  // new turn: a fresh reviewer dispatch, claimed at the boundary, launched, settled
  s = applyEvent(s, nextEvent(s, "DISPATCH_RESERVE", { dispatch_id: "reviewer-2", reserved_seconds: 10 }))
  s = applyEvent(s, nextEvent(s, "DISPATCH_PREPARE", { dispatch_id: "reviewer-2", claim_required: true, expected_agent: "harness-reviewer", prepared_by_session_id: "owner" }))
  s = applyEvent(s, nextEvent(s, "DISPATCH_LAUNCH_CLAIM", { dispatch_id: "reviewer-2", call_id: "call-2" }))
  s = applyEvent(s, nextEvent(s, "DISPATCH_LAUNCH", { dispatch_id: "reviewer-2", session_id: "ses-reviewer" }))
  s = applyEvent(s, nextEvent(s, "DISPATCH_FINISH", { dispatch_id: "reviewer-2", result: "review done" }))
  s = applyEvent(s, nextEvent(s, "DISPATCH_RECONCILE", { dispatch_id: "reviewer-2", actual_consumption: 10 }))

  // candidate + independent PASS review + immutable PR binding + exact-head CI
  s = applyEvent(s, nextEvent(s, "FREEZE_CANDIDATE", { candidate_id: "cand-1", manifest_hash: "m1", tree_hash: "t1", wu_id: "WU-01" }))
  s = applyEvent(s, nextEvent(s, "RECORD_REVIEW", { candidate_id: "cand-1", verdict: "PASS", candidate_hashes: { manifest_hash: "m1", tree_hash: "t1" }, verification_evidence_ids: ["ev-1"], verified_check_ids: [], verification_contract_hash: null }))
  s = applyEvent(s, nextEvent(s, "BIND_PR", { repository: "o/r", pr_number: 158, candidate_id: "cand-1", head_sha: "head-a", base_branch: "main", base_sha: "base-1" }))
  s = applyEvent(s, nextEvent(s, "RECORD_CI", { candidate_id: "cand-1", head_sha: "head-a", check_identity: "check-1", conclusion: "SUCCESS" }))

  // governed merge → VERIFIED
  s = applyEvent(s, nextEvent(s, "MERGE_START", {}))
  s = applyEvent(s, nextEvent(s, "MERGE_RECORD", { merge_commit_sha: "merge-1", merged_head_sha: "head-a" }))
  s = applyEvent(s, nextEvent(s, "MERGE_VERIFY", {}))
  assert.equal(s.merge.status, "VERIFIED")

  // WU_COMPLETE succeeds, no artificial BLOCK anywhere
  s = applyEvent(s, nextEvent(s, "WU_COMPLETE", { candidate_id: "cand-1" }))
  assert.equal(s.wu.completed, true)
  assert.equal(s.blocker, null)

  // the next authorized WU can activate (the Epic continues)
  s = applyEvent(s, nextEvent(s, "WU_ACTIVATE", { wu_id: "WU-02", mandate_id: "M1" }))
  assert.equal(s.wu.wu_id, "WU-02")
})
