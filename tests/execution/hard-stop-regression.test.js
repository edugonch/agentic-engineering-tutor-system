import test from "node:test"
import assert from "node:assert/strict"
import { applyEvent, project } from "../../src/execution/state.js"
import { stableHash } from "../../src/execution/serialize.js"
import { TERMINAL_BLOCKER_CLASSES } from "../../src/execution/constants.js"

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

const TERMINAL = [...TERMINAL_BLOCKER_CLASSES]

for (const blockerClass of TERMINAL) {
  test(`terminal blocker ${blockerClass}: no forward execution, no merge, no WU_COMPLETE`, () => {
    const ev = makeBuilder()
    const events = [
      ev("MANDATE_APPROVE", MANDATE),
      ev("WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }),
      ev("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 10 }),
      ev("DISPATCH_PREPARE", { dispatch_id: "d1", claim_required: true, expected_agent: "harness-reviewer" }),
      ev("BLOCK", { class: blockerClass, reason: "hard stop" }),
    ]
    const s = project(events)
    assert.equal(s.blocker.class, blockerClass)

    // terminal blocker + PENDING_LAUNCH → DISPATCH_LAUNCH_CLAIM rejected
    assert.throws(
      () => applyEvent(s, nextEvent(s, "DISPATCH_LAUNCH_CLAIM", { dispatch_id: "d1", call_id: "call-1" })),
      /Forward execution is blocked/,
    )
    // merge is forward execution → rejected
    assert.throws(
      () => applyEvent(s, nextEvent(s, "MERGE_START", {})),
      /Forward execution is blocked/,
    )
    assert.throws(
      () => applyEvent(s, nextEvent(s, "MERGE_EXTERNAL_RECORD", { merge_commit_sha: "x", merged_head_sha: "head-a" })),
      /Forward execution is blocked/,
    )
    // WU_COMPLETE cannot close under a hard stop
    assert.throws(
      () => applyEvent(s, nextEvent(s, "WU_COMPLETE", { candidate_id: "cand-1" })),
      /terminal blocker/,
    )
    // the blocker is not silently cleared
    assert.equal(s.blocker.class, blockerClass)
  })
}

test("transient turn-boundary: CHECKPOINT records a handoff but leaves state.blocker null", () => {
  const ev = makeBuilder()
  const events = [
    ev("MANDATE_APPROVE", MANDATE),
    ev("WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }),
    ev("CHECKPOINT", { note: "turn boundary handoff" }),
  ]
  const s = project(events)
  assert.equal(s.blocker, null) // no BLOCK is created for a transient boundary
  assert.ok(s.checkpoint) // the handoff is durably recorded
  assert.equal(s.checkpoint.note, "turn boundary handoff")
})
