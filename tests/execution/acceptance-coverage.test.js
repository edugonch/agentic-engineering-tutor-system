import test from "node:test"
import assert from "node:assert/strict"
import { inspectAcceptanceCoverage } from "../../src/execution/acceptance-coverage.js"
import { validateVerificationContract } from "../../src/execution/verification.js"
import { verificationContractHash } from "../../src/execution/verification-contract.js"
import { stableHash } from "../../src/execution/serialize.js"

const base = { commands: [{ id: "unit", program: "node", args: ["--test"] }],
  setup: [{ id: "install", program: "npm", args: ["ci"] }],
  capabilities: [], environment: { network_policy: "UNRESTRICTED" } }
const withCoverage = acceptance_coverage => ({ ...base, acceptance_coverage })

test("legacy contracts keep their exact historical verification hash and remain admissible", () => {
  const oldNormative = { commands: base.commands, setup: base.setup, capabilities: base.capabilities,
    environment: base.environment }
  assert.equal(verificationContractHash(base), stableHash(oldNormative))
  assert.equal(validateVerificationContract(base), true)
  const result = inspectAcceptanceCoverage(base)
  assert.equal(result.status, "COVERAGE_NOT_DEMONSTRATED")
  assert.equal(result.blocking, false)
  assert.equal(result.functional_acceptance_proven, false)
})

test("explicit REQUIRED mode blocks incomplete mappings rather than guessing check coverage", () => {
  const c = withCoverage({ schema_version: 1, mode: "REQUIRED",
    criteria: ["A", "B"], check_mapping: { A: ["unit"] } })
  assert.equal(inspectAcceptanceCoverage(c).status, "REQUIRED_CHECK_UNMAPPED")
  assert.throws(() => validateVerificationContract(c), /REQUIRED_CHECK_UNMAPPED/)
  assert.notEqual(verificationContractHash(c), verificationContractHash(base))
})

test("ADVISORY mode never adds a missing-coverage admission blocker", () => {
  const c = withCoverage({ schema_version: 1, mode: "ADVISORY",
    criteria: ["A", "B"], check_mapping: { A: ["unit"] } })
  assert.equal(validateVerificationContract(c), true)
  assert.equal(inspectAcceptanceCoverage(c).status, "COVERAGE_NOT_DEMONSTRATED")
})

test("setup is not a check, unknown IDs and duplicate mappings are detected", () => {
  for (const check_mapping of [
    { A: ["install"] }, { A: ["future-browser-test"] },
    { A: ["unit", "unit"] }, { A: ["unit"], EXTRA: ["unit"] },
  ]) {
    const c = withCoverage({ schema_version: 1, mode: "REQUIRED",
      criteria: ["A"], check_mapping })
    assert.throws(() => validateVerificationContract(c), /REQUIRED_CHECK_UNMAPPED/)
  }
})

test("documentary WU does not acquire implicit DB or browser obligations", () => {
  const c = withCoverage({ schema_version: 1, mode: "REQUIRED",
    criteria: ["doc"], check_mapping: { doc: ["unit"] } })
  assert.equal(validateVerificationContract(c), true)
  const result = inspectAcceptanceCoverage(c)
  assert.equal(result.status, "DECLARED_MAPPING_COMPLETE_NOT_SEMANTICALLY_VERIFIED")
  assert.equal(result.capability_status, "NOT_OBSERVED")
  assert.equal(result.write_scope_status, "NOT_STRUCTURED")
  assert.equal(result.functional_acceptance_proven, false)
})

test("npm test alone cannot demonstrate PostgreSQL two-writer concurrency", () => {
  const c = { commands: [{ id: "npm-test", program: "npm", args: ["test"] }] }
  assert.equal(inspectAcceptanceCoverage(c).status, "COVERAGE_NOT_DEMONSTRATED")
  const strict = { ...c, acceptance_coverage: { schema_version: 1, mode: "REQUIRED",
    criteria: ["two-real-writers"], check_mapping: {} } }
  assert.throws(() => validateVerificationContract(strict), /REQUIRED_CHECK_UNMAPPED/)
})

test("invalid version and malformed criteria never silently claim complete coverage", () => {
  for (const c of [
    withCoverage({ schema_version: 2, mode: "REQUIRED", criteria: [], check_mapping: {} }),
    withCoverage({ schema_version: 1, mode: "REQUIRED", criteria: ["A", "A"], check_mapping: { A: ["unit"] } }),
  ]) assert.throws(() => validateVerificationContract(c), /INVALID_ACCEPTANCE_COVERAGE/)
})
