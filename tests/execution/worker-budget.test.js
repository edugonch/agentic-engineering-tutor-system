import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { createWorkerBudgetGuard } from "../../src/execution/worker-budget.js"

test("worker expiry interrupts the exact child, preserves reservation and records recoverable budget cause", async t => {
  const root = await mkdtemp(join(tmpdir(), "worker-budget-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const c = await createExecutionController({ dir: join(root, ".harness/execution/controller/E") })
  const commit = async (operation_type, body) => {
    const lease = await c.acquire("root"), { state } = await c.snapshot()
    return c.commit({ operation_id: `op-${state.revision}`, operation_type, body },
      { holder_session_id: "root", expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  await commit("MANDATE_APPROVE", { mandate_id: "M", total_seconds: 100, max_wus: 1 })
  await commit("WU_ACTIVATE", { mandate_id: "M", wu_id: "WU1" })
  await commit("DISPATCH_RESERVE", { dispatch_id: "D", reserved_seconds: 10 })
  await commit("DISPATCH_PREPARE", { dispatch_id: "D", prepared_by_session_id: "root", expected_agent: "harness-builder", claim_required: true })
  await commit("DISPATCH_LAUNCH_CLAIM", { dispatch_id: "D", call_id: "call" })
  await commit("DISPATCH_LAUNCH", { dispatch_id: "D", session_id: "child" })
  const interrupts = []
  const ctx = { session: { get: async ({ sessionID }) => ({ id: sessionID, parentID: "root", agent: "harness-builder" }),
    interrupt: async input => { interrupts.push(input) } } }
  const guard = createWorkerBudgetGuard(ctx, root, {}, { now: () => Date.now() + 20000 })
  t.after(() => guard.dispose())
  assert.equal(await guard.inspect("unrelated", "harness-builder"), undefined)
  await assert.rejects(guard.inspect("child", "harness-builder"), /HARNESS_BUDGET_EXHAUSTED/)
  let state
  const deadline = Date.now() + 2000
  do {
    await new Promise(resolve => setTimeout(resolve, 10))
    state = (await c.snapshot()).state
  } while (!state.blocker && Date.now() < deadline)
  assert.deepEqual(interrupts, [{ sessionID: "child", continue: false }])
  assert.equal(state.blocker.class, "BUDGET_EXHAUSTED")
  assert.equal(state.blocker.budget_reason, "reservation_expired")
  assert.equal(state.budget.reserved_seconds, 10)
  assert.equal(state.budget.used_seconds, 0)
  assert.deepEqual(guard.failures(), [])
})
