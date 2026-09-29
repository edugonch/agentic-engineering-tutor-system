import test from "node:test"
import assert from "node:assert/strict"
import { createContinuationDriver, readContinuationSettings, shouldContinue } from "../../src/execution/continuation-driver.js"

test("readContinuationSettings is disabled by default and parses overrides", () => {
  assert.deepEqual(readContinuationSettings({}), { enabled: false, maxContinuations: 1 })
  assert.equal(readContinuationSettings({ HARNESS_CONTINUATION_ENABLED: "1" }).enabled, true)
  assert.equal(readContinuationSettings({ HARNESS_CONTINUATION_ENABLED: "true" }).enabled, true)
  assert.equal(readContinuationSettings({ HARNESS_CONTINUATION_ENABLED: "0" }).enabled, false)
  assert.equal(readContinuationSettings({ HARNESS_CONTINUATION_MAX: "2" }).maxContinuations, 2)
  assert.equal(readContinuationSettings({ HARNESS_CONTINUATION_MAX: "0" }).maxContinuations, 1)
})

test("shouldContinue enumerates every refusal reason", () => {
  assert.deepEqual(shouldContinue(null, 1), { continue: false, reason: "not-a-probe-session" })
  const probe = { steps: 2, stepCount: 0, continuationsUsed: 0, blocked: false }
  assert.deepEqual(shouldContinue(probe, 1), { continue: false, reason: "steps-not-exhausted" })
  probe.stepCount = 2
  assert.deepEqual(shouldContinue(probe, 1), { continue: true })
  probe.continuationsUsed = 1
  assert.deepEqual(shouldContinue(probe, 1), { continue: false, reason: "max-continuations" })
  probe.continuationsUsed = 0
  probe.blocked = true
  assert.deepEqual(shouldContinue(probe, 1), { continue: false, reason: "blocked" })
})

function stubCtx(prompts) {
  return { session: { prompt: async (args) => { prompts.push(args) } } }
}

test("driver counts steps, marks internal, and continues at most once", async () => {
  const prompts = []
  const driver = createContinuationDriver(stubCtx(prompts), { enabled: true, maxContinuations: 1 })
  driver.registerProbe({ sessionID: "s1", steps: 2 })
  driver.onContext({ sessionID: "s1" })
  driver.onContext({ sessionID: "s1" })

  assert.equal(await driver.onIdle("other"), false) // not a probe
  assert.equal(await driver.onIdle("s1"), true) // exhausted -> continue
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionID, "s1")

  // the continuation prompt is internal and cleared on first read
  assert.equal(driver.isInternalPrompt("s1"), true)
  assert.equal(driver.isInternalPrompt("s1"), false)

  // continuation budget exhausted -> no further continue
  assert.equal(await driver.onIdle("s1"), false)
  assert.equal(prompts.length, 1)
})

test("a blocked probe never continues, even after step exhaustion", async () => {
  const prompts = []
  const driver = createContinuationDriver(stubCtx(prompts), { enabled: true, maxContinuations: 1 })
  driver.registerProbe({ sessionID: "s1", steps: 2 })
  driver.onContext({ sessionID: "s1" })
  driver.onContext({ sessionID: "s1" })
  driver.markBlocked("s1")
  assert.equal(await driver.onIdle("s1"), false)
  assert.equal(prompts.length, 0)
})

test("onEvent reacts only to session.idle for a registered probe", async () => {
  const prompts = []
  const driver = createContinuationDriver(stubCtx(prompts), { enabled: true, maxContinuations: 1 })
  driver.registerProbe({ sessionID: "s1", steps: 1 })
  driver.onContext({ sessionID: "s1" })

  assert.equal(await driver.onEvent({ type: "session.updated" }), false) // wrong type
  assert.equal(await driver.onEvent({ type: "session.idle", properties: { sessionID: "unknown" } }), false) // unregistered
  assert.equal(await driver.onEvent({ type: "session.idle", properties: { sessionID: "s1" } }), true) // continue
  assert.equal(prompts.length, 1)
})

test("a disabled driver ignores everything", async () => {
  const prompts = []
  const driver = createContinuationDriver(stubCtx(prompts), { enabled: false, maxContinuations: 1 })
  driver.registerProbe({ sessionID: "s1", steps: 1 })
  driver.onContext({ sessionID: "s1" })
  assert.equal(await driver.onIdle("s1"), false)
  assert.equal(prompts.length, 0)
})
