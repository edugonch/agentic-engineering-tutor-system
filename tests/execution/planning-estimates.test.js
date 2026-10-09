import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { createWorkerBudgetGuard } from "../../src/execution/worker-budget.js"
import { PLANNING_ESTIMATES, epicExecutionRemaining } from "../../src/execution/time-policy.js"
import { runWithExternalWait } from "../../src/execution/external-wait.js"

async function fixture(t, { planning = false, total = 10000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "planning-estimates-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const c = await createExecutionController({ dir: join(root, ".harness/execution/controller/E") })
  const commit = async (operation_type, body) => {
    const lease = await c.acquire("root"), { state } = await c.snapshot()
    return c.commit({ operation_id: `op-${state.revision}`, operation_type, body },
      { holder_session_id: "root", expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  await commit("MANDATE_APPROVE", { execution_id: "E:exec", mandate_id: "M", total_seconds: total, max_wus: 2,
    ...(planning ? { time_policy: PLANNING_ESTIMATES } : {}) })
  await commit("WU_ACTIVATE", { mandate_id: "M", wu_id: "WU065" })
  const run = (action, extra = {}) => runExecutionController(root, { action, execution_id: "E", session_id: "root", ...extra })
  const decision = async (overrides = {}, metadata = {}) => {
    const { state } = await c.snapshot()
    return recordKnowledgeArtifact(root, { artifact_type: "decision", artifact_id: `TIME-${state.revision}`, title: "Owner: WU times are planning estimates",
      status: "APPROVED", owner_confirmed: true, source_refs: ["https://example.com/owner-instruction"],
      content: `Owner authorized removing WU/worker time cutoffs; retain Epic total and all acceptance gates.\ntime_policy: ${JSON.stringify({ execution_id: "E", mandate_id: "M", mode: PLANNING_ESTIMATES, blocked_at_revision: state.blocker?.at_revision ?? null, epic_total_seconds: total, ...overrides })}`,
      ...metadata })
  }
  return { root, c, commit, run, decision }
}

test("WU065 budget stop migrates once, preserving accounting and every historical event", async t => {
  const f = await fixture(t)
  await f.commit("DISPATCH_RESERVE", { dispatch_id: "partial", reserved_seconds: 1952 })
  await f.commit("DISPATCH_LAUNCH", { dispatch_id: "partial", session_id: "interrupted" })
  await f.commit("DISPATCH_FINISH", { dispatch_id: "partial", result: "partial repair preserved" })
  await f.commit("DISPATCH_RECONCILE", { dispatch_id: "partial" })
  await f.commit("BLOCK", { class: "BUDGET_EXHAUSTED", reason: "448 left, prior review took 578" })
  const authority = await f.decision()
  const before = await f.c.snapshot()
  const migrated = await f.run("adopt_planning_estimates", { decision_artifact_id: authority.record_key })
  assert.equal(migrated.blocker, null)
  assert.equal(migrated.time_policy.mode, PLANNING_ESTIMATES)
  assert.equal(migrated.wu_budget.enforced, false)
  const after = await f.c.snapshot()
  assert.deepEqual(after.events.slice(0, -1), before.events)
  for (const key of ["budget", "dispatches", "wu", "candidates", "reviews", "mandate"]) assert.deepEqual(after.state[key], before.state[key])
  assert.equal((await f.run("adopt_planning_estimates", { decision_artifact_id: authority.record_key })).commit_status, "replayed")
  await f.run("reserve", { dispatch_id: "repair", reserved_seconds: 1000 })
  assert.equal((await f.run("verify")).passed, true)
  await assert.rejects(f.run("block", { class: "BUDGET_EXHAUSTED", reason: "WU estimate exceeded" }), /estimates are advisory/)
})

for (const scenario of ["unsettled", "security", "stale", "epic-change", "unapproved", "tampered"]) {
  test(`planning migration refuses ${scenario}`, async t => {
    const f = await fixture(t)
    if (scenario === "unsettled") await f.commit("DISPATCH_RESERVE", { dispatch_id: "D", reserved_seconds: 10 })
    if (scenario === "security") await f.commit("BLOCK", { class: "BLOCKED_SECURITY", reason: "retain" })
    const a = await f.decision(scenario === "stale" ? { blocked_at_revision: 999 } : scenario === "epic-change" ? { epic_total_seconds: 20000 } : {},
      scenario === "unapproved" ? { status: "PROPOSED" } : {})
    if (scenario === "tampered") await appendFile(join(f.root, a.path), "\nmodified")
    const before = await f.c.snapshot()
    await assert.rejects(f.run("adopt_planning_estimates", { decision_artifact_id: a.record_key }), /Settle|unrelated|baseline|mismatch|owner-approved|INTEGRITY/)
    assert.deepEqual((await f.c.snapshot()).state, before.state)
  })
}

test("Epic exhaustion is preserved by migration and still prevents new work", async t => {
  const f = await fixture(t, { total: 10 })
  await f.commit("PHASE_START", { phase: "ACTIVE", started_at: 0 })
  await f.commit("PHASE_END", { ended_at: 10 })
  await f.commit("BLOCK", { class: "BUDGET_EXHAUSTED", reason: "Epic consumed" })
  const a = await f.decision()
  const result = await f.run("adopt_planning_estimates", { decision_artifact_id: a.record_key })
  assert.equal(result.blocker.class, "BUDGET_EXHAUSTED")
  assert.equal(result.budget.used_seconds, 10)
  await assert.rejects(f.run("reserve", { dispatch_id: "no", reserved_seconds: 1 }), /BUDGET/)
})

test("builder survives expired reservation; elapsed overrun is still charged and CI can proceed", async t => {
  const f = await fixture(t, { planning: true })
  await f.commit("WU_CONTRACT_BIND", { contract: { wu_id: "WU065", active_seconds: 10 } })
  await f.commit("DISPATCH_RESERVE", { dispatch_id: "D", reserved_seconds: 10 })
  await f.commit("DISPATCH_PREPARE", { dispatch_id: "D", prepared_by_session_id: "root", expected_agent: "harness-builder", claim_required: true })
  await f.commit("DISPATCH_LAUNCH_CLAIM", { dispatch_id: "D", call_id: "call" })
  await f.commit("DISPATCH_LAUNCH", { dispatch_id: "D", session_id: "child" })
  const guard = createWorkerBudgetGuard({ session: { get: async () => ({ id: "child", parentID: "root", agent: "harness-builder" }), interrupt: () => assert.fail("Estimate must not interrupt") } }, f.root, {}, { now: () => Date.now() + 20000 })
  t.after(() => guard.dispose())
  const context = await guard.inspect("child", "harness-builder")
  assert.equal(context.estimate_exceeded, true)
  assert.equal(context.time_policy, "planning_estimate")
  assert.ok(context.remaining_execution_seconds > 9000)
  assert.equal((await f.c.snapshot()).state.blocker, null)
  const { state } = await f.c.snapshot()
  const d = state.dispatches.D
  assert.ok(epicExecutionRemaining(state, { worker: d, nowMs: Date.parse(d.launch_claimed_at) + 20000 }) <= 9980)
  // Runtime handoff supplies observed envelope. Never manufacture model usage.
  await f.commit("DISPATCH_USAGE", { dispatch_id: "D", seconds: 20, session_id: "child", call_id: "call", source: "runtime.monotonic_dispatch_envelope" })
  await f.commit("DISPATCH_FINISH", { dispatch_id: "D", result: "done" })
  await f.commit("DISPATCH_RECONCILE", { dispatch_id: "D" })
  assert.equal((await f.c.snapshot()).state.budget.used_seconds, 20)
  assert.equal((await f.run("status")).wu_budget.estimate_overrun_seconds, 10)
  let observed = false
  await runWithExternalWait({ controller: f.c, session_id: "root", operation: "merge", run: async () => { observed = true; return { status: "PENDING" } } })
  assert.equal(observed, true)
})

test("new owner-approved mandates default to estimates", async t => {
  const f = await fixture(t)
  await recordKnowledgeArtifact(f.root, { artifact_type: "epic", artifact_id: "EPIC", title: "Epic", status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.com/owner-instruction"], content: 'execution_mandate: {"max_wus":2,"total_seconds":10000}' })
  const args = { execution_id: "NEW", session_id: "root", action: "approve_mandate", epic_artifact_id: "EPIC" }
  assert.equal((await runExecutionController(f.root, args)).time_policy.mode, PLANNING_ESTIMATES)
  assert.equal((await runExecutionController(f.root, args)).commit_status, "replayed")
})

test("legacy progress hashes remain byte-compatible before policy adoption", async () => {
  const { executionProgress } = await import("../../src/execution/progress.js")
  const { stableHash } = await import("../../src/execution/serialize.js")
  const state = { mandate: { id: "old" }, wu: {}, budget: {}, dispatches: {}, candidates: {}, reviews: {}, ci_evidence: {}, pr_binding: null, merge: null }
  assert.equal(executionProgress(state), stableHash({ mandate: state.mandate, wu: state.wu, budget: state.budget,
    dispatches: state.dispatches, candidates: state.candidates, reviews: state.reviews, ci: state.ci_evidence,
    binding: state.pr_binding, merge: state.merge, external_wait: state.external_wait }))
})
