import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { createWorkerBudgetGuard } from "../../src/execution/worker-budget.js"

test("worker duration overrun never interrupts the child or raises a time blocker", async t => {
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
  const context = await guard.inspect("child", "harness-builder")
  const state = (await c.snapshot()).state
  assert.equal(context.time_policy, "planning_estimate")
  assert.equal(context.enforced, false)
  assert.equal(context.estimate_exceeded, true)
  assert.ok(context.estimate_overrun_seconds >= 10)
  assert.equal(context.dispatch_id, "D")
  assert.deepEqual(interrupts, [])
  assert.equal(state.blocker, null)
  assert.equal(state.budget.reserved_seconds, 10)
  assert.equal(state.budget.used_seconds, 0)
  assert.deepEqual(guard.failures(), [])
})
