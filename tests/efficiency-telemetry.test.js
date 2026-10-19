import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEfficiencyTelemetry, extractRuntimeUsage, summarizeUsage } from "../src/execution/efficiency-telemetry.js"

test("unknown fields never become fabricated zero usage or billable cost", () => {
  assert.equal(extractRuntimeUsage({ type: "message.updated", properties: { info: { id: "m", sessionID: "s" } } }), null)
  const s = summarizeUsage({})
  assert.equal(s.tokens_input, "unknown")
  assert.equal(s.tokens_output, "unknown")
  assert.equal(s.estimated_cost, "unknown")
  assert.equal(s.measured_usage_available, false)
})
test("runtime token messages are deduplicated and persisted without message content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-usage-"))
  try {
    const tracker = createEfficiencyTelemetry(dir, { enabled: true })
    tracker.associate("session-1", "E", "WU-01", "BUILD")
    const event = { type: "message.updated", properties: { info: {
      id: "message-1", sessionID: "session-1", modelID: "model",
      tokens: { input: 120, output: 40, cache: { read: 25, write: 3 } },
      content: "PRIVATE TEXT MUST NOT BE SAVED" } } }
    await tracker.onEvent(event)
    await tracker.onEvent({ ...event, properties: { info: { ...event.properties.info,
      tokens: { input: 130, output: 55, cache: { read: 26, write: 3 } } } } })
    const report = await createEfficiencyTelemetry(dir, { enabled: true }).report("E", "WU-01")
    assert.equal(report.message_count, 1)
    assert.equal(report.tokens_input, 130)
    assert.equal(report.tokens_output, 55)
    assert.equal(report.estimated_cost, "unknown")
    assert.equal(JSON.stringify(report).includes("PRIVATE"), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
