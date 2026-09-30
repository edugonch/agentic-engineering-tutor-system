import test from "node:test"
import assert from "node:assert/strict"
import { budgetStatus, checkExecutionReadiness, deriveRequirements, pathDigest } from "../../src/execution/readiness.js"

const contract = {
  commands: [{ id: "unit", program: "node", args: ["--test", "app.test.js"] }],
  capabilities: ["shell.node"],
  environment: { network_policy: "UNRESTRICTED" },
}
const readyProbe = () => ({ status: "READY" })

test("all available → READY", async () => {
  const result = await checkExecutionReadiness({ contract, phase: "BUILD", probe: readyProbe, budget: { remaining: 100, buildReserve: 10, reviewReserve: 10 } })
  assert.equal(result.status, "READY")
  assert.ok(result.requirements.length >= 6)
  assert.equal(result.budget.status, "READY")
})

test("a required binary disappearing → BLOCKED_CAPABILITY", async () => {
  const probe = (capability) => (capability === "binary.node" ? { status: "BLOCKED", reason: "node not on PATH" } : { status: "READY" })
  const result = await checkExecutionReadiness({ contract, phase: "BUILD", probe, budget: { remaining: 100 } })
  assert.equal(result.status, "BLOCKED_CAPABILITY")
  assert.equal(result.requirements.find((r) => r.capability === "binary.node").reason, "node not on PATH")
})

test("reviewer present but cannot use the verification tool → blocked", async () => {
  const probe = (capability) => (capability === "reviewer.execute_declared_checks" ? { status: "BLOCKED", reason: "reviewer lacks harness_run_verification" } : { status: "READY" })
  const result = await checkExecutionReadiness({ contract, phase: "BUILD", probe, budget: { remaining: 100 } })
  assert.equal(result.status, "BLOCKED_CAPABILITY")
})

test("a declared browser that is absent → blocked", async () => {
  const browserContract = { commands: [{ id: "u", program: "node", args: [] }], capabilities: ["browser.headless"] }
  const probe = (capability) => (capability === "browser.headless" ? { status: "BLOCKED", reason: "browser unavailable" } : { status: "READY" })
  const result = await checkExecutionReadiness({ contract: browserContract, phase: "BUILD", probe, budget: { remaining: 100 } })
  assert.equal(result.status, "BLOCKED_CAPABILITY")
  assert.equal(result.requirements.find((r) => r.capability === "browser.headless").reason, "browser unavailable")
})

test("insufficient budget → BLOCKED_BUDGET (separate from capability)", async () => {
  const result = await checkExecutionReadiness({ contract, phase: "BUILD", probe: readyProbe, budget: { remaining: 5, buildReserve: 10, reviewReserve: 10 } })
  assert.equal(result.status, "BLOCKED_BUDGET")
  assert.equal(result.budget.status, "BLOCKED_BUDGET")
  assert.equal(result.requirements.every((r) => r.status === "READY"), true)
})

test("a volatile recheck before REVIEW catches a binary that vanished after BUILD", async () => {
  const build = await checkExecutionReadiness({ contract, phase: "BUILD", probe: readyProbe, budget: { remaining: 100 } })
  assert.equal(build.status, "READY")

  const reviewProbe = (capability) => (capability === "binary.node" ? { status: "BLOCKED", reason: "node removed after build" } : { status: "READY" })
  const review = await checkExecutionReadiness({ contract, phase: "REVIEW", probe: reviewProbe, budget: { remaining: 100 } })
  assert.equal(review.status, "BLOCKED_CAPABILITY")
  // REVIEW phase re-checks only VOLATILE requirements (no STABLE agent checks)
  assert.equal(review.requirements.some((r) => r.capability === "builder.present"), false)
  assert.equal(review.requirements.some((r) => r.capability === "binary.node"), true)
})

test("an undeclared capability is never required", async () => {
  const requirements = deriveRequirements(contract, { phase: "BUILD" })
  assert.equal(requirements.some((r) => r.capability === "browser.headless"), false)
  assert.equal(requirements.some((r) => r.capability === "binary.node"), true)
})

test("READY neither creates nor modifies authority/state", async () => {
  const input = { commands: [{ id: "u", program: "node", args: [] }] }
  const before = JSON.stringify(input)
  const result = await checkExecutionReadiness({ contract: input, phase: "BUILD", probe: readyProbe, budget: { remaining: 100 } })
  assert.equal(result.status, "READY")
  assert.equal(JSON.stringify(input), before) // input unchanged
  assert.equal("authorized" in result, false)
  assert.equal("mandate" in result, false)
  assert.equal("activation" in result, false)
})

test("budgetStatus and pathDigest are deterministic", async () => {
  assert.equal(budgetStatus({ remaining: 9, buildReserve: 5, reviewReserve: 5 }).status, "BLOCKED_BUDGET")
  assert.equal(budgetStatus({ remaining: 10, buildReserve: 5, reviewReserve: 5 }).status, "READY")
  assert.equal(pathDigest("/a:/b"), pathDigest("/a:/b"))
  assert.notEqual(pathDigest("/a:/b"), pathDigest("/a:/c"))
})
