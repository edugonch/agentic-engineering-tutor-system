import test from "node:test"
import assert from "node:assert/strict"
import { initialState } from "../../src/execution/state.js"
import { compileWuContract } from "../../src/execution/wu-contract.js"
import { validateContractCorrection } from "../../src/execution/contract-correction.js"
import { applyProcessEvent } from "../../src/execution/process-recovery.js"
import { auditRecovery } from "../../src/execution/controller-inspection.js"

// Reproduces ALFRAN E05-07-E: an orphaned builder was fenced, abandoned,
// and reconciled. Its final status must not be mistaken for a running worker.
function correctionFixture(status = "abandoned_reconciled") {
  const base = { active_seconds: 2453, process_obligations: [], verification_contract: {
    setup: [{ id: "jit-install", program: "npm", args: ["ci"], timeout_ms: 300000 }],
    commands: [{ id: "jit-test", program: "npm", args: ["run", "test"], timeout_ms: 300000 }],
    environment: { network_policy: "UNRESTRICTED" }, capabilities: [],
  } }
  const compile = typed => compileWuContract("E05-07-E", {
    content: "The original accepted booking seam scope.\nexecution_contract: " + JSON.stringify(typed),
    source_record_key: "approved-wu", source_hash: "a".repeat(64), source_authority: "APPROVED",
  })
  const old = compile(base)
  const extended = structuredClone(base)
  extended.verification_contract.commands[0].timeout_ms = 600000
  const next = compile(extended)
  const state = { ...initialState(), wu: { wu_id: "E05-07-E", contract: old, completed: false },
    dispatches: { "e0507-build-2": { status, reservation_status: "consumed" } },
    blocker: { class: "BLOCKED_TOOLING" } }
  const body = { contract: next, expected_contract_hash: old.contract_hash,
    reason: "Exact previously approved technical timeout extension", check_mapping: { "jit-test": ["jit-test"] } }
  return { state, body }
}

test("E05-07-E: terminal abandoned_reconciled builder permits governed contract correction", () => {
  const { state, body } = correctionFixture()
  const original = structuredClone(state)
  assert.doesNotThrow(() => validateContractCorrection(state, body))
  assert.deepEqual(state, original, "preflight cannot mutate history or accounting")
})

for (const status of ["reserved", "pending_launch", "launched", "finished", "abandoned", "ambiguous"]) {
  test(`E05-07-E: ${status} dispatch still prevents contract correction`, () => {
    const { state, body } = correctionFixture(status)
    assert.throws(() => validateContractCorrection(state, body), /settled dispatches, phases and merge/)
  })
}

test("retrospective process recovery accepts a reconciled abandonment, never an active dispatch", () => {
  const make = status => {
    const state = initialState()
    state.execution_id = "alfran-epic05-delivery"
    state.wu = { wu_id: "E05-07-E", completed: false }
    state.process_policy = { policy: { recoverable: ["TDD_ORDER"] }, source_hash: "f".repeat(64) }
    state.dispatches = { "e0507-build-2": { status } }
    state.merge = null
    return state
  }
  const body = { wu_id: "E05-07-E", kind: "TDD_ORDER",
    reason: "Prior document existed before RED", evidence_ref: "real RED receipt and mutation evidence",
    blocked_at_revision: null }
  const recovered = make("abandoned_reconciled")
  assert.doesNotThrow(() => applyProcessEvent(recovered, { operation_type: "PROCESS_RECOVERY_START", body }))
  assert.equal(recovered.process_recoveries["E05-07-E"].status, "REPAIRING")
  const running = make("launched")
  assert.throws(() => applyProcessEvent(running, { operation_type: "PROCESS_RECOVERY_START", body }), /Settle existing work/)
})

test("recovery audit classifies abandoned_reconciled as settled without modifying state", async () => {
  const state = initialState()
  state.execution_id = "alfran-epic05-delivery"
  state.mandate = { mandate_id: "M", wu_sequence: ["E05-07-E"] }
  state.wu = { wu_id: "E05-07-E" }
  state.dispatches = {
    "e0507-build-2": { status: "abandoned_reconciled" },
    "e0507-still-live": { status: "launched" },
  }
  const before = structuredClone(state)
  const result = await auditRecovery({ snapshot: async () => ({ state, events: [] }) })
  assert.deepEqual(result.canonical_ledger.unfinished_dispatches, [
    { dispatch_id: "e0507-still-live", status: "launched" },
  ])
  assert.deepEqual(state, before)
})
