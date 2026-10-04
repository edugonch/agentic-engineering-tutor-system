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
  assert.deepEqual(state.mandate, { mandate_id: "M1", mandate_revision: "r0", max_wus: 4, authority_kind: "PROBE" })
  assert.equal(state.wu.execution_authorization, "AUTHORIZED_BY_MANDATE")
  assert.equal(state.wu.origin, "DERIVED")
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
    ev("RECORD_REVIEW", { candidate_id: "A", verdict: "CHANGES_REQUIRED", candidate_hashes: { manifest_hash: "mhA", tree_hash: "thA" } }, 2, 3),
  ]
  const state = project(events)
  assert.equal(state.reviews.A.verdict, "CHANGES_REQUIRED")

  const mismatch = [
    ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 4, total_seconds: 60 }, 0, 1),
    ev("FREEZE_CANDIDATE", { candidate_id: "A", manifest_hash: "mhA", tree_hash: "thA" }, 1, 2),
    ev("RECORD_REVIEW", { candidate_id: "A", verdict: "CHANGES_REQUIRED", candidate_hashes: { manifest_hash: "mhA", tree_hash: "thB" } }, 2, 3),
  ]
  assert.throws(() => project(mismatch), /different candidate/)
})

test("initial state has revision 0 and empty projections", () => {
  const s = initialState()
  assert.equal(s.revision, 0)
  assert.equal(s.blocker, null)
  assert.deepEqual(s.dispatches, {})
  assert.deepEqual(s.activated_wu_ids, [])
})

test("WU_ACTIVATE rejects a second WU while the first is incomplete", () => {
  let state = project([
    ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 2, total_seconds: 60 }, 0, 1),
    ev("WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }, 1, 2),
  ])
  assert.throws(
    () => applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-02", mandate_id: "M1" }, 2, 3)),
    /not complete/,
  )
})

test("WU_ACTIVATE rejects activation beyond mandate max_wus", () => {
  let state = initialState()
  state = applyEvent(state, ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 1, total_seconds: 60 }, 0, 1))
  state = applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }, 1, 2))
  state = applyEvent(state, ev("FREEZE_CANDIDATE", { candidate_id: "c1", wu_id: "WU-01", manifest_hash: "mh", tree_hash: "th" }, 2, 3))
  state = applyEvent(state, ev("RECORD_REVIEW", { candidate_id: "c1", verdict: "PASS", candidate_hashes: { manifest_hash: "mh", tree_hash: "th" }, verification_evidence_ids: ["v1"], verified_check_ids: [] }, 3, 4))
  state = applyEvent(state, ev("WU_COMPLETE", { candidate_id: "c1" }, 4, 5))
  assert.equal(state.wu.completed, true)
  assert.throws(
    () => applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-02", mandate_id: "M1" }, 5, 6)),
    /max_wus/,
  )
})

test("COMPLETE (Epic) rejects while the active WU is incomplete", () => {
  let state = initialState()
  state = applyEvent(state, ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 2, total_seconds: 60 }, 0, 1))
  state = applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }, 1, 2))
  assert.throws(
    () => applyEvent(state, ev("COMPLETE", { result: "done" }, 2, 3)),
    /active WU/,
  )
})

test("MANDATE_APPROVE with a governed source binding stores the authority", () => {
  const state = project([
    ev("MANDATE_APPROVE", { execution_id: "exec", mandate_id: "M1", mandate_revision: "rev-1", max_wus: 2, total_seconds: 60, source_artifact_id: "epic-001", source_record_key: "rk-1", source_hash: "h1" }, 0, 1),
  ])
  assert.equal(state.mandate.source_artifact_id, "epic-001")
  assert.equal(state.mandate.source_record_key, "rk-1")
  assert.equal(state.mandate.source_hash, "h1")
})

test("RECORD_REVIEW PASS without full verification coverage is rejected", () => {
  const state = project([
    ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 2, total_seconds: 60 }, 0, 1),
    ev("FREEZE_CANDIDATE", { candidate_id: "A", manifest_hash: "mhA", tree_hash: "thA", verification_contract_hash: "ch1", required_check_ids: ["unit", "lint"] }, 1, 2),
  ])
  assert.throws(
    () => applyEvent(state, ev("RECORD_REVIEW", { candidate_id: "A", verdict: "PASS", candidate_hashes: { manifest_hash: "mhA", tree_hash: "thA" }, verification_evidence_ids: ["v1"], verified_check_ids: ["unit"], verification_contract_hash: "ch1" }, 2, 3)),
    /coverage/,
  )
  const ok = applyEvent(state, ev("RECORD_REVIEW", { candidate_id: "A", verdict: "PASS", candidate_hashes: { manifest_hash: "mhA", tree_hash: "thA" }, verification_evidence_ids: ["v1", "v2"], verified_check_ids: ["unit", "lint"], verification_contract_hash: "ch1" }, 2, 3))
  assert.equal(ok.reviews.A.verdict, "PASS")
  assert.deepEqual(ok.reviews.A.verified_check_ids, ["unit", "lint"])
})

test("RECORD_REVIEW PASS with duplicate check coverage is rejected", () => {
  const state = project([
    ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 2, total_seconds: 60 }, 0, 1),
    ev("FREEZE_CANDIDATE", { candidate_id: "A", manifest_hash: "mhA", tree_hash: "thA", verification_contract_hash: "ch1", required_check_ids: ["unit", "lint"] }, 1, 2),
  ])
  assert.throws(
    () => applyEvent(state, ev("RECORD_REVIEW", { candidate_id: "A", verdict: "PASS", candidate_hashes: { manifest_hash: "mhA", tree_hash: "thA" }, verification_evidence_ids: ["v1", "v2"], verified_check_ids: ["unit", "unit"], verification_contract_hash: "ch1" }, 2, 3)),
    /duplicate check coverage/,
  )
})

test("MANDATE_APPROVE defaults to PROBE and records governed authority_kind", () => {
  const probe = project([ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 2, total_seconds: 60 }, 0, 1)])
  assert.equal(probe.mandate.authority_kind, "PROBE")
  const governed = project([ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 2, total_seconds: 60, authority_kind: "OWNER_APPROVED_EPIC", source_artifact_id: "epic-1", source_record_key: "rk-1", source_hash: "h1" }, 0, 1)])
  assert.equal(governed.mandate.authority_kind, "OWNER_APPROVED_EPIC")
})

test("MANDATE_APPROVE OWNER_APPROVED_EPIC without a complete source binding is rejected", () => {
  assert.throws(
    () => project([ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 2, total_seconds: 60, authority_kind: "OWNER_APPROVED_EPIC" }, 0, 1)]),
    /source_artifact_id/,
  )
})


test("MANDATE_APPROVE derives Epic last_jit_refresh from the durable event timestamp", () => {
  const timestamp = "2026-10-04T04:40:00.000Z"
  const state = project([
    ev(
      "MANDATE_APPROVE",
      {
        execution_id: "exec",
        mandate_id: "M1",
        max_wus: 2,
        total_seconds: 60,
        wu_queue: [
          { wu_id: "WU-1", wu_contract_path: "wu-1.md", dependencies: [] },
          { wu_id: "WU-2", wu_contract_path: "wu-2.md", dependencies: ["WU-1"] },
        ],
      },
      0,
      1,
      { timestamp },
    ),
  ])

  assert.equal(state.epic.last_jit_refresh, timestamp)
})

test("EPIC_CONTINUE derives JIT refresh from its durable event and replay is stable", () => {
  const initialTimestamp = "2026-10-04T04:40:00.000Z"
  const continueTimestamp = "2026-10-04T04:41:00.000Z"
  const events = [
    ev(
      "MANDATE_APPROVE",
      {
        execution_id: "exec",
        mandate_id: "M1",
        max_wus: 2,
        total_seconds: 60,
        wu_queue: [
          { wu_id: "WU-1", wu_contract_path: "wu-1.md", dependencies: [] },
          { wu_id: "WU-2", wu_contract_path: "wu-2.md", dependencies: ["WU-1"] },
        ],
      },
      0,
      1,
      { timestamp: initialTimestamp },
    ),
    ev("WU_ACTIVATE", { wu_id: "WU-1", mandate_id: "M1" }, 1, 2),
    ev("FREEZE_CANDIDATE", { candidate_id: "c1", wu_id: "WU-1", manifest_hash: "mh", tree_hash: "th" }, 2, 3),
    ev(
      "RECORD_REVIEW",
      {
        candidate_id: "c1",
        verdict: "PASS",
        candidate_hashes: { manifest_hash: "mh", tree_hash: "th" },
        verification_evidence_ids: ["v1"],
        verified_check_ids: [],
        verification_contract_hash: null,
      },
      3,
      4,
    ),
    ev("WU_COMPLETE", { candidate_id: "c1" }, 4, 5),
    ev("EPIC_CONTINUE", {}, 5, 6, { timestamp: continueTimestamp }),
  ]

  const first = project(events)
  const second = project(structuredClone(events))
  assert.equal(first.epic.last_jit_refresh, continueTimestamp)
  assert.deepEqual(second, first)
  assert.equal(first.wu.wu_id, "WU-2")
})

test("legacy Epic events without timestamps replay deterministically with a null JIT timestamp", () => {
  const state = project([
    ev(
      "MANDATE_APPROVE",
      {
        execution_id: "exec",
        mandate_id: "M1",
        max_wus: 1,
        total_seconds: 60,
        wu_queue: [{ wu_id: "WU-1", wu_contract_path: "wu-1.md", dependencies: [] }],
      },
      0,
      1,
      { timestamp: undefined },
    ),
  ])

  assert.equal(state.epic.last_jit_refresh, null)
})
