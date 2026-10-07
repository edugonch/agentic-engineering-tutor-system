import test from "node:test"
import assert from "node:assert/strict"
import { applyEvent, initialState } from "../../src/execution/state.js"
import { stableHash } from "../../src/execution/serialize.js"

function ev(type, body, state) {
  const next = state.revision + 1
  return {
    sequence: next,
    event_id: `e-${next}`,
    operation_id: `op-${next}`,
    operation_type: type,
    operation_hash: stableHash(body),
    body,
    previous_revision: state.revision,
    next_revision: next,
    fencing_token: 1,
    timestamp: "t",
  }
}

function approve(sequence = ["WU-01", "WU-02"]) {
  let state = initialState()
  state = applyEvent(state, ev("MANDATE_APPROVE", {
    execution_id: "exec",
    mandate_id: "M1",
    mandate_revision: "r1",
    max_wus: 4,
    total_seconds: 100,
    wu_sequence: sequence,
  }, state))
  return state
}

function completeCurrent(state, candidateId) {
  state = applyEvent(state, ev("FREEZE_CANDIDATE", {
    candidate_id: candidateId,
    wu_id: state.wu.wu_id,
    manifest_hash: `m-${candidateId}`,
    tree_hash: `t-${candidateId}`,
  }, state))
  state = applyEvent(state, ev("RECORD_REVIEW", {
    candidate_id: candidateId,
    verdict: "PASS",
    candidate_hashes: { manifest_hash: `m-${candidateId}`, tree_hash: `t-${candidateId}` },
    verification_evidence_ids: ["v1"],
    verified_check_ids: [],
    verification_contract_hash: null,
  }, state))
  return applyEvent(state, ev("WU_COMPLETE", { candidate_id: candidateId }, state))
}

test("frozen WU sequence permits only the next declared WU", () => {
  let state = approve(["WU-01", "WU-02"])
  assert.throws(
    () => applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-X", mandate_id: "M1" }, state)),
    /next frozen WU is WU-01/,
  )
  state = applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }, state))
  state = completeCurrent(state, "c1")
  assert.throws(
    () => applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-03", mandate_id: "M1" }, state)),
    /next frozen WU is WU-02/,
  )
  state = applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-02", mandate_id: "M1" }, state))
  assert.equal(state.wu.wu_id, "WU-02")
})

test("Epic COMPLETE is blocked until every frozen WU is completed", () => {
  let state = approve(["WU-01", "WU-02"])
  state = applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }, state))
  state = completeCurrent(state, "c1")
  assert.throws(
    () => applyEvent(state, ev("COMPLETE", { result: "premature" }, state)),
    /remaining WUs: WU-02/,
  )
  state = applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-02", mandate_id: "M1" }, state))
  state = completeCurrent(state, "c2")
  state = applyEvent(state, ev("COMPLETE", { result: "done" }, state))
  assert.equal(state.completed, true)
})

test("frozen sequence exhaustion cannot authorize a new successor", () => {
  let state = approve(["WU-01"])
  state = applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }, state))
  state = completeCurrent(state, "c1")
  assert.throws(
    () => applyEvent(state, ev("WU_ACTIVATE", { wu_id: "WU-02", mandate_id: "M1" }, state)),
    /sequence is exhausted; EPIC_REBASE_REQUIRED/,
  )
})
