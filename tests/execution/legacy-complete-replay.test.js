import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initialState, applyEvent, project } from "../../src/execution/state.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { findPendingLaunchBinding } from "../../src/execution/launch-binding.js"
import { findWuExecution } from "../../src/execution/execution-query.js"
import { stableHash } from "../../src/execution/serialize.js"

const makeEvents = (ops) => ops.map(([operation_type, body], index) => ({
  sequence: index + 1, event_id: `historic-${index + 1}`, operation_id: `legacy-${index + 1}`,
  operation_type, operation_hash: stableHash(body), body,
  previous_revision: index, next_revision: index + 1,
  fencing_token: 1, timestamp: "2026-10-09T00:00:00.000Z",
}))
const base = [
  ["MANDATE_APPROVE", { execution_id: "P3A-SMOKE", mandate_id: "M1", max_wus: 2, total_seconds: 100 }],
  ["WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }],
]
const legacyComplete = makeEvents([...base, ["COMPLETE", { result: "historical terminal" }]])

test("legacy terminal COMPLETE remains replayable without fabricating WU completion", () => {
  const source = JSON.stringify(legacyComplete)
  const state = project(legacyComplete)
  assert.equal(state.completed, true)
  assert.equal(state.wu.completed, false)
  assert.deepEqual(state.completed_wus, {})
  assert.equal(state.budget.used_seconds, 0)
  assert.equal(state.budget.reserved_seconds, 0)
  assert.equal(JSON.stringify(legacyComplete), source)
  assert.deepEqual(project(legacyComplete), state)
})

test("new COMPLETE still rejects an active unfinished WU and an incomplete frozen sequence", () => {
  const active = project(makeEvents(base))
  assert.throws(() => applyEvent(active, makeEvents([...base, ["COMPLETE", {}]]).at(-1)),
    /COMPLETE blocked: active WU WU-01 is not complete/)
  const frozenOps = [
    ["MANDATE_APPROVE", { mandate_id: "M1", max_wus: 2, total_seconds: 100, wu_sequence: ["WU-01", "WU-02"] }],
    ["WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }],
  ]
  assert.equal(project(makeEvents([...frozenOps, ["COMPLETE", {}]])).completed, true)
  const frozen = project(makeEvents(frozenOps))
  assert.throws(() => applyEvent(frozen, makeEvents([...frozenOps, ["COMPLETE", {}]]).at(-1)),
    /active WU/)
})

test("controller snapshot and unrelated launch discovery accept an old COMPLETE log", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-complete-replay-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const parent = join(root, ".harness/execution/controller")
  const oldDir = join(parent, "P3A-SMOKE")
  const liveDir = join(parent, "active-build")
  await mkdir(oldDir, { recursive: true })
  await mkdir(liveDir, { recursive: true })
  const oldContent = legacyComplete.map(event => JSON.stringify(event)).join("\n") + "\n"
  await writeFile(join(oldDir, "events.ndjson"), oldContent)
  const activeEvents = makeEvents([
    ["MANDATE_APPROVE", { execution_id: "active-build", mandate_id: "M2", max_wus: 2, total_seconds: 100 }],
    ["WU_ACTIVATE", { wu_id: "WU-NEW", mandate_id: "M2" }],
    ["DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 40 }],
    ["DISPATCH_PREPARE", { dispatch_id: "d1", prepared_by_session_id: "root", expected_agent: "harness-builder", claim_required: true }],
  ])
  await writeFile(join(liveDir, "events.ndjson"), activeEvents.map(event => JSON.stringify(event)).join("\n") + "\n")
  const legacyState = (await (await createExecutionController({ dir: oldDir })).snapshot()).state
  assert.equal(legacyState.completed, true)
  assert.equal((await findWuExecution(root, "WU-NEW")).execution_id, "active-build")
  assert.deepEqual(await findPendingLaunchBinding(root, "root", "harness-builder"),
    { execution_id: "active-build", dispatch_id: "d1" })
  assert.equal(await readFile(join(oldDir, "events.ndjson"), "utf8"), oldContent)
})
