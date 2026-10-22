import test from "node:test"
import assert from "node:assert/strict"
import { compileWuContract } from "../../src/execution/wu-contract.js"
import { validateContractCorrection, deriveVerificationCorrection } from "../../src/execution/contract-correction.js"
import { verificationContractHash } from "../../src/execution/verification-contract.js"
import { stableHash } from "../../src/execution/serialize.js"

function fixture() {
  const verification = {
    setup: [{ id: "jit-install", program: "npm", args: ["ci"], timeout_ms: 300000 }],
    commands: [
      { id: "jit-test", program: "npm", args: ["run", "test"], timeout_ms: 300000 },
      { id: "jit-lint", program: "npm", args: ["run", "lint"], timeout_ms: 300000 },
    ],
    environment: { network_policy: "UNRESTRICTED" }, capabilities: [],
  }
  const old = compileWuContract("E05-07-E", {
    content: 'Accepted doc-only outcome, no runtime changes.\nexecution_contract: ' +
      JSON.stringify({ active_seconds: 1200, process_obligations: [], verification_contract: verification }),
    source_record_key: "original-wu", source_hash: "a".repeat(64), source_authority: "APPROVED",
  })
  const state = { wu: { wu_id: "E05-07-E", contract: old, completed: false }, completed: false,
    process_policy: { source_hash: "p".repeat(64), policy: { technical_verification: true } },
    budget: { active_phase: null }, verification_phase: null, dispatches: {}, merge: null, blocker: null }
  const proposal = changed => {
    const draft = { wu_id: "E05-07-E", source_authority: "DELEGATED_TECHNICAL",
      source_record_key: "timeout-technical-proposal", source_hash: "b".repeat(64),
      policy_source_hash: state.process_policy.source_hash,
      verification_contract: changed, verification_contract_hash: verificationContractHash(changed) }
    return { ...draft, contract_hash: stableHash(draft) }
  }
  const correct = changed => {
    const next = deriveVerificationCorrection(old, proposal(changed))
    return validateContractCorrection(state, { mode: "verification_only", contract: next,
      expected_contract_hash: old.contract_hash, reason: "Measured JIT timeout, same frozen commands",
      check_mapping: { "jit-test": ["jit-test"], "jit-lint": ["jit-lint"] } })
  }
  return { verification, correct, state }
}

test("virtual E05-07-E recovery: technical delegation can extend a timed-out frozen check", () => {
  const { verification, correct } = fixture()
  const longer = structuredClone(verification)
  longer.commands[0].timeout_ms = 420000
  assert.doesNotThrow(() => correct(longer))
  const setupLonger = structuredClone(verification)
  setupLonger.setup[0].timeout_ms = 420000
  assert.doesNotThrow(() => correct(setupLonger))
})

test("delegation cannot weaken timeout, remove checks or change a command", () => {
  const { verification, correct } = fixture()
  const shorter = structuredClone(verification)
  shorter.commands[0].timeout_ms = 120000
  assert.throws(() => correct(shorter), /Delegated correction/)
  const missing = structuredClone(verification)
  missing.commands.pop()
  assert.throws(() => correct(missing), /Delegated correction|mapping/)
  const changed = structuredClone(verification)
  changed.commands[0].args = ["run", "test:fast"]
  assert.throws(() => correct(changed), /Delegated correction/)
  const setupChanged = structuredClone(verification)
  setupChanged.setup[0].args = ["install"]
  assert.throws(() => correct(setupChanged), /Delegated correction/)
})

test("technical timeout correction still requires existing delegated process authority", () => {
  const { verification, correct, state } = fixture()
  const changed = structuredClone(verification)
  changed.commands[0].timeout_ms = 420000
  state.process_policy.policy.technical_verification = false
  assert.throws(() => correct(changed), /approved source provenance/)
})
