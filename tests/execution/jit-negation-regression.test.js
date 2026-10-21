import test from "node:test"
import assert from "node:assert/strict"
import { isTechnicalWuContractBlocker } from "../../src/execution/jit-contract.js"

const blocker = reason => ({ class: "BLOCKED_AUTHORITY", reason,
  authority_question: { domain: "governance" }, at_revision: 77 })

test("reproduced negation of WU_CONTRACT_REQUIRED is not treated as recovery authority", () => {
  assert.equal(isTechnicalWuContractBlocker(blocker("This is NOT a WU_CONTRACT_REQUIRED condition.")), false)
  assert.equal(isTechnicalWuContractBlocker(blocker("This is NOT an execution_contract problem.")), false)
  assert.equal(isTechnicalWuContractBlocker(blocker("This is not a normalization contract failure.")), false)
})

test("legitimate positive legacy contract stop remains discoverable but not owner permission", () => {
  assert.equal(isTechnicalWuContractBlocker(blocker("WU_CONTRACT_REQUIRED: no executable approved contract")), true)
  assert.equal(isTechnicalWuContractBlocker(blocker("A finite active_seconds limit is required")), true)
})

test("a product, scope or safety authority question is never contract triage", () => {
  const b = blocker("WU_CONTRACT_REQUIRED")
  b.authority_question.domain = "scope"
  assert.equal(isTechnicalWuContractBlocker(b), false)
  b.class = "BLOCKED_TOOLING"
  assert.equal(isTechnicalWuContractBlocker(b), false)
})
