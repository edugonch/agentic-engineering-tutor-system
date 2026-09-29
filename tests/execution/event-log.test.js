import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readLog, validateLog, writeLog } from "../../src/execution/event-log.js"

const event = (sequence, operation_id) => ({
  sequence,
  event_id: `e${sequence}`,
  operation_id,
  operation_type: "CHECKPOINT",
  operation_hash: "h",
  body: null,
  previous_revision: sequence - 1,
  next_revision: sequence,
  fencing_token: 1,
  timestamp: new Date().toISOString(),
})

test("writes and reads an event log atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-eventlog-"))
  const path = join(root, "events.ndjson")
  try {
    await writeLog(path, [event(1, "op-1"), event(2, "op-2")])
    const events = await readLog(path)
    assert.equal(events.length, 2)
    assert.deepEqual(events.map((e) => e.sequence), [1, 2])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("rejects a sequence gap", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-eventlog-gap-"))
  const path = join(root, "events.ndjson")
  try {
    await writeFile(path, [JSON.stringify(event(1, "op-1")), JSON.stringify(event(3, "op-3"))].join("\n"))
    const events = await readLog(path)
    assert.throws(() => validateLog(events), /sequence gap/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("rejects a malformed event", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-eventlog-mal-"))
  const path = join(root, "events.ndjson")
  try {
    await writeFile(path, JSON.stringify({ sequence: 1, operation_id: "op-1" }) + "\n")
    const events = await readLog(path)
    assert.throws(() => validateLog(events), /Malformed event/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("treats an empty or missing log as no events", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-eventlog-empty-"))
  try {
    assert.deepEqual(await readLog(join(root, "events.ndjson")), [])
    await writeFile(join(root, "events.ndjson"), "\n")
    assert.deepEqual(await readLog(join(root, "events.ndjson")), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
