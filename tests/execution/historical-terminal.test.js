import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stableHash } from "../../src/execution/serialize.js"
import { isValidatedHistoricalTerminal } from "../../src/execution/historical-terminal.js"
import { findPendingLaunchBinding } from "../../src/execution/launch-binding.js"
import { findWuExecution } from "../../src/execution/execution-query.js"

const event = (operation_type, body, index) => ({
  sequence: index + 1, event_id: `e-${index}`, operation_id: `o-${index}`,
  operation_type, body, operation_hash: stableHash(body),
  previous_revision: index, next_revision: index + 1, fencing_token: 1, timestamp: "2026-10-09T00:00:00Z",
})
const build = (ops) => ops.map(([kind, body], index) => event(kind, body, index))
const completedOps = [
  ["MANDATE_APPROVE", { mandate_id: "M", total_seconds: 120, max_wus: 2 }],
  ["WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M" }],
  ["COMPLETE", { result: "historical" }],
]
async function persist(dir, events) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "events.ndjson"), events.map(x => JSON.stringify(x)).join("\n") + "\n")
}

test("historical-terminal exception is narrowly scoped to verified COMPLETE replay failures", async t => {
  const root = await mkdtemp(join(tmpdir(), "historical-terminal-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacyError = new Error("COMPLETE blocked: active WU WU-01 is not complete.")
  await persist(root, build(completedOps))
  assert.equal(await isValidatedHistoricalTerminal(root, legacyError), true)
  assert.equal(await isValidatedHistoricalTerminal(root, new Error("Unrelated corruption")), false)
  await persist(root, build([...completedOps, ["CHECKPOINT", { note: "audit" }]]))
  assert.equal(await isValidatedHistoricalTerminal(root, legacyError), true)
  await persist(root, build([...completedOps, ["WU_ACTIVATE", { wu_id: "WU-02", mandate_id: "M" }]]))
  assert.equal(await isValidatedHistoricalTerminal(root, legacyError), false)
  const tampered = build(completedOps)
  tampered[2].body.result = "forged"
  await persist(root, tampered)
  assert.equal(await isValidatedHistoricalTerminal(root, legacyError), false)
  const badRevision = build(completedOps)
  badRevision[2].previous_revision = 99
  await persist(root, badRevision)
  assert.equal(await isValidatedHistoricalTerminal(root, legacyError), false)
})

test("unknown or corrupt active executions still fail closed in launch discovery", async t => {
  const root = await mkdtemp(join(tmpdir(), "historical-active-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const activeDir = join(root, ".harness/execution/controller/active-corrupt")
  await persist(activeDir, build([
    ["MANDATE_APPROVE", { mandate_id: "M2", total_seconds: 100, max_wus: 1 }],
    ["WU_ACTIVATE", { wu_id: "WU-NEW", mandate_id: "M2" }],
    ["DISPATCH_PREPARE", { dispatch_id: "not-reserved", expected_agent: "harness-builder", prepared_by_session_id: "root" }],
  ]))
  await assert.rejects(findPendingLaunchBinding(root, "root", "harness-builder"), /not reserved/)
  await assert.rejects(findWuExecution(root, "WU-NEW"), /not reserved/)
})
