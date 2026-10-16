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

async function fixture(t, planning = false) {
  const dir = await mkdtemp(join(tmpdir(), "verify-budget-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const c = await createExecutionController({ dir })
  const commit = async (type, body) => {
    const lease = await c.acquire("root"), { state } = await c.snapshot()
    return c.commit({ operation_type: type, operation_id: `test-${state.revision}`, body },
      { holder_session_id: "root", expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  const contract = { source_wu_id: "WU1", commands: [{ id: "check", program: "node", args: ["--version"] }] }
  await commit("MANDATE_APPROVE", { mandate_id: "M", max_wus: 1, total_seconds: 100, ...(planning ? { time_policy: "WU_PLANNING_ESTIMATES" } : {}) })
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

test("reviewer with exact live launch evidence uses its reservation without acquiring parent lease", async t => {
  const { c, commit, candidate } = await fixture(t)
  await commit("DISPATCH_RESERVE", { dispatch_id: "review", reserved_seconds: 8 })
  await commit("DISPATCH_PREPARE", { dispatch_id: "review", prepared_by_session_id: "root", expected_agent: "harness-reviewer", claim_required: true })
  await commit("DISPATCH_LAUNCH_CLAIM", { dispatch_id: "review", call_id: "review-call" })
  const runtimeSession = { id: "child", parentID: "root", agent: "harness-reviewer" }
  const launchEvidence = [{ type: "assistant", content: [{ type: "tool", name: "subagent", id: "review-call",
    state: { input: { agent: "harness-reviewer" }, metadata: { sessionID: "child" } } }] }]
  const before = await c.snapshot()
  const args = { controller: c, candidate, context: { sessionID: "child" }, runtimeSession, launchEvidence }
  const result = await withVerificationBudget({ ...args, run: async ({ budgetMs }) => {
    assert.ok(budgetMs > 0 && budgetMs <= 8000)
    return { status: "PASS" }
  } })
  assert.equal(result.status, "PASS")
  assert.deepEqual(await c.snapshot(), before)
  await assert.rejects(withVerificationBudget({ ...args, launchEvidence: [], run: () => assert.fail() }), /DISPATCH_IDENTITY/)
  await assert.rejects(withVerificationBudget({ ...args, runtimeSession: { ...runtimeSession, parentID: "other" }, run: () => assert.fail() }), /DISPATCH_IDENTITY/)
})


test("planning estimates allow verification after WU and reviewer reservation overruns", async t => {
  const { c, commit, candidate } = await fixture(t, true)
  await commit("PHASE_START", { phase: "ACTIVE", started_at: 0 })
  await commit("PHASE_END", { ended_at: 12 })
  assert.equal(wuBudgetUsage((await c.snapshot()).state, "WU1").available_seconds, -2)
  let ticks = 0
  const result = await withVerificationBudget({ controller: c, candidate, context: { sessionID: "root" },
    monotonic: () => (ticks++ % 2) * 2000, run: async ({ budgetMs }) => {
      assert.equal(budgetMs, 30000) // command timeout, not the exhausted WU estimate
      return { status: "PASS" }
    } })
  assert.equal(result.status, "PASS")
  assert.equal((await c.snapshot()).state.budget.used_seconds, 14)
  await commit("DISPATCH_RESERVE", { dispatch_id: "review", reserved_seconds: 0 })
  await commit("DISPATCH_PREPARE", { dispatch_id: "review", prepared_by_session_id: "root", expected_agent: "harness-reviewer", claim_required: true })
  await commit("DISPATCH_LAUNCH_CLAIM", { dispatch_id: "review", call_id: "review-call" })
  await commit("DISPATCH_LAUNCH", { dispatch_id: "review", session_id: "child" })
  const before = await c.snapshot()
  assert.equal((await withVerificationBudget({ controller: c, candidate, context: { sessionID: "child" }, run: async ({ budgetMs }) => {
    assert.ok(budgetMs > 0)
    return { status: "PASS" }
  } })).status, "PASS")
  assert.deepEqual(await c.snapshot(), before, "reviewer does not acquire parent lease or double-charge its interval")
})


test("RED: a verified prior setup timeout permits one budgeted unchanged frozen check retry under BLOCKED_TOOLING", async t => {
  const { c, commit, candidate } = await fixture(t, true)
  await commit("BLOCK", { class: "BLOCKED_TOOLING", reason: "Frozen verification setup npm ci timed out after 120000 ms" })
  const candidate_id = "cand-" + "d".repeat(64)
  candidate.candidate_id = candidate_id
  await commit("FREEZE_CANDIDATE", { candidate_id, wu_id: "WU1", manifest_hash: "mh", tree_hash: "th" })
  const before = (await c.snapshot()).state
  let executed = 0
  await assert.rejects(withVerificationBudget({
    controller: c, candidate, check_id: "check", context: { sessionID: "root" },
    run: async () => { executed++; return { status: "PASS" } },
  }), /BLOCKED_TOOLING/)
  assert.equal(executed, 0)
  await assert.rejects(withVerificationBudget({
    controller: c, candidate, check_id: "check", context: { sessionID: "root" },
    setupRecovery: { kind: "VERIFIED_SETUP_TIMEOUT", blocked_at_revision: before.blocker.at_revision - 1, check_id: "check", source_wu_id: "WU1" },
    run: async () => { executed++; return { status: "PASS" } },
  }), /BLOCKED_TOOLING|recovery/i)
  assert.equal(executed, 0)
  await commit("VERIFICATION_RETRY_ATTEMPT", {
    blocked_at_revision: before.blocker.at_revision, wu_id: "WU1",
    candidate_id, check_id: "check",
    verification_contract_hash: (await c.snapshot()).state.wu.contract.verification_contract_hash,
    failure_evidence_id: "verify-" + "c".repeat(64), setup_id: "install",
  })
  const result = await withVerificationBudget({
    controller: c, candidate, check_id: "check", context: { sessionID: "root" },
    setupRecovery: { kind: "VERIFIED_SETUP_TIMEOUT", blocked_at_revision: before.blocker.at_revision, check_id: "check", source_wu_id: "WU1" },
    run: async ({ budgetMs }) => {
      executed++
      assert.ok(budgetMs > 0)
      assert.ok(budgetMs <= 30000)
      return { status: "PASS" }
    },
  })
  assert.equal(result.status, "PASS")
  assert.equal(executed, 1)
  const after = (await c.snapshot()).state
  assert.equal(after.blocker.class, "BLOCKED_TOOLING", "execution alone never clears a blocker")
  assert.equal(after.budget.active_phase, null)
  assert.equal(after.verification_phase, undefined)
  assert.equal((await c.snapshot()).events.filter(e => e.operation_type === "PHASE_END").length, 1)
})

test("RED: no recovery admission for authority/security blockers or a subagent without an active dispatch", async t => {
  for (const blockClass of ["BLOCKED_AUTHORITY", "BLOCKED_SECURITY"]) {
    const { c, commit, candidate } = await fixture(t, true)
    await commit("BLOCK", { class: blockClass, reason: "not a tooling setup failure" })
    const blocker = (await c.snapshot()).state.blocker
    await assert.rejects(withVerificationBudget({
      controller: c, candidate, check_id: "check", context: { sessionID: "root" },
      setupRecovery: { kind: "VERIFIED_SETUP_TIMEOUT", blocked_at_revision: blocker.at_revision, check_id: "check", source_wu_id: "WU1" },
      run: async () => assert.fail("no execution permitted"),
    }), /BLOCKED_AUTHORITY|BLOCKED_SECURITY/)
  }
})
