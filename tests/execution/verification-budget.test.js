import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { verificationContractHash } from "../../src/execution/verification-contract.js"
import { withVerificationBudget, recoverVerificationPhase } from "../../src/execution/verification-budget.js"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { wuBudgetUsage } from "../../src/execution/wu-budget.js"

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "verify-budget-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const c = await createExecutionController({ dir })
  const commit = async (type, body) => {
    const lease = await c.acquire("root"), { state } = await c.snapshot()
    return c.commit({ operation_type: type, operation_id: `test-${state.revision}`, body },
      { holder_session_id: "root", expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  const contract = { source_wu_id: "WU1", commands: [{ id: "check", program: "node", args: ["--version"] }] }
  await commit("MANDATE_APPROVE", { mandate_id: "M", max_wus: 1, total_seconds: 100 })
  await commit("WU_ACTIVATE", { wu_id: "WU1", mandate_id: "M", contract: { active_seconds: 10,
    verification_contract: contract, verification_contract_hash: verificationContractHash(contract) } })
  return { c, commit, candidate: { verification_contract: contract } }
}

test("root verification charges measured duration, including failed checks, and cannot spend it again", async t => {
  const { c, candidate } = await fixture(t)
  let ticks = 0
  const args = { controller: c, candidate, context: { sessionID: "root" }, monotonic: () => (ticks++ % 2) * 6000 }
  await withVerificationBudget({ ...args, run: async ({ budgetMs }) => { assert.equal(budgetMs, 10000); return { status: "FAIL" } } })
  let state = (await c.snapshot()).state
  assert.equal(state.budget.used_seconds, 6)
  assert.equal(wuBudgetUsage(state, "WU1").available_seconds, 4)
  await assert.rejects(withVerificationBudget({ ...args, run: async ({ budgetMs }) => { assert.equal(budgetMs, 4000); throw new Error("cancelled") } }), /cancelled/)
  state = (await c.snapshot()).state
  assert.equal(state.budget.used_seconds, 12) // observed overrun is retained, never hidden
  assert.equal(state.budget.active_phase, null)
  assert.equal((await withVerificationBudget({ ...args, run: () => assert.fail("must not run") })).status, "BLOCKED_BUDGET")
})

test("verification cannot overlap itself, close the WU, or substitute the approved contract", async t => {
  const { c, candidate, commit } = await fixture(t)
  const args = { controller: c, candidate, context: { sessionID: "root", id: "one" } }
  await withVerificationBudget({ ...args, run: async () => {
    await assert.rejects(recoverVerificationPhase({ controller: c, session_id: "root" }), /OWNER_ALIVE/)
    await assert.rejects(withVerificationBudget({ ...args, context: { sessionID: "root", id: "two" }, run: () => assert.fail() }), /IN_PROGRESS/)
    await assert.rejects(commit("COMPLETE", {}), /active phase/)
    return { status: "PASS" }
  } })
  await assert.rejects(withVerificationBudget({ ...args, candidate: { verification_contract: { ...candidate.verification_contract, commands: [] } }, run: () => assert.fail() }), /does not match/)
})

test("dead verification owner has a supported conservative recovery without claiming PASS", async t => {
  const { c, commit } = await fixture(t)
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
  await once(child, "exit")
  await commit("PHASE_START", { phase: "ACTIVE", started_at: Date.now() / 1000, source: "runtime.verification",
    session_id: "root", owner_pid: child.pid, owner_death_guard: 1, authorized_seconds: 10 })
  const result = await recoverVerificationPhase({ controller: c, session_id: "root" })
  assert.equal(result.result, "UNKNOWN_NOT_ACCEPTANCE")
  assert.equal(result.charged_seconds, 10)
  const state = (await c.snapshot()).state
  assert.equal(state.budget.used_seconds, 10)
  assert.equal(state.budget.active_phase, null)
  assert.equal((await recoverVerificationPhase({ controller: c, session_id: "root" })).status, "NO_VERIFICATION_TO_RECOVER")
})
