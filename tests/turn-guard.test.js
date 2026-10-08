import test from "node:test"
import assert from "node:assert/strict"
import { applyOutputTokenCap, createTurnGuard, readGuardSettings, GUARD_ERROR_CODES } from "../src/turn-guard.js"

function expectGuardThrow(fn, code, messagePattern) {
  let caught = null
  try {
    fn()
  } catch (err) {
    caught = err
  }
  assert.ok(caught, `expected a guard error (${code}) to be thrown`)
  assert.equal(caught.name, "HarnessGuardError")
  assert.equal(caught.code, code)
  assert.match(caught.message, messagePattern)
  return caught
}

test("defaults to no total tool-call or delegation ceiling and ignores invalid overrides", () => {
  assert.deepEqual(readGuardSettings({}), {
    maxToolCalls: null,
    maxDelegations: null,
    maxIdenticalMutations: 4,
    maxOutputTokens: null,
  })
  assert.deepEqual(readGuardSettings({ HARNESS_MAX_TOOL_CALLS: "0", HARNESS_MAX_DELEGATIONS: "0" }), {
    maxToolCalls: null,
    maxDelegations: null,
    maxIdenticalMutations: 4,
    maxOutputTokens: null,
  })
})

test("enables each ceiling only when explicitly configured", () => {
  assert.equal(readGuardSettings({ HARNESS_MAX_TOOL_CALLS: "7" }).maxToolCalls, 7)
  assert.equal(readGuardSettings({ HARNESS_MAX_DELEGATIONS: "5" }).maxDelegations, 5)
})

test("leaves provider request options untouched unless the output-token cap is explicitly enabled", () => {
  const options = { temperature: 0.2 }
  assert.equal(applyOutputTokenCap(options, null), options)
  assert.deepEqual(options, { temperature: 0.2 })
  assert.equal(readGuardSettings({}).maxOutputTokens, null)
  assert.equal(readGuardSettings({ HARNESS_MAX_OUTPUT_TOKENS: "2048" }).maxOutputTokens, 2048)
})

test("applies an explicitly configured output-token cap without raising a lower request limit", () => {
  const uncapped = { temperature: 0.2 }
  applyOutputTokenCap(uncapped, 2048)
  assert.equal(uncapped.maxTokens, 2048)

  const high = { maxTokens: 4096 }
  applyOutputTokenCap(high, 2048)
  assert.equal(high.maxTokens, 2048)

  const lower = { maxTokens: 512 }
  applyOutputTokenCap(lower, 2048)
  assert.equal(lower.maxTokens, 512)
})

test("allows substantially more than 40 harmless reads when no total ceiling is configured", () => {
  const guard = createTurnGuard(readGuardSettings({}))
  assert.doesNotThrow(() => {
    for (let i = 0; i < 200; i += 1) {
      guard.before({ tool: "read", sessionID: "s1" }, { args: { filePath: `f${i}` } })
    }
  })
  assert.equal(guard.snapshot("s1").calls, 200)
})

test("delegation ceiling is off by default and does not stop a normal governed flow", () => {
  const guard = createTurnGuard()
  // build → review → repair → review needs 4 delegations; far more must still
  // be allowed because the delegation guard is not a WU budget.
  for (let i = 0; i < 40; i++) {
    assert.doesNotThrow(() => guard.before({ tool: "subagent", sessionID: "governed" }, { args: { description: `work-${i}` } }))
  }
})

test("tool-call ceiling trips with a machine-readable code when configured", () => {
  const guard = createTurnGuard({ maxToolCalls: 2, maxDelegations: null, maxIdenticalMutations: 4 })
  guard.before({ tool: "read", sessionID: "s1" }, { args: { filePath: "a" } })
  guard.before({ tool: "read", sessionID: "s1" }, { args: { filePath: "b" } })
  expectGuardThrow(
    () => guard.before({ tool: "read", sessionID: "s1" }, { args: {} }),
    GUARD_ERROR_CODES.TOOL_CALL_LIMIT_EXCEEDED,
    /exceeded 2 tool calls/,
  )
})

test("explicit delegation ceiling blocks the next delegation with a machine-readable code", () => {
  const guard = createTurnGuard(readGuardSettings({ HARNESS_MAX_DELEGATIONS: "3" }))
  guard.before({ tool: "subagent", sessionID: "s1" }, { args: { description: "build" } })
  guard.before({ tool: "subagent", sessionID: "s1" }, { args: { description: "review" } })
  guard.before({ tool: "subagent", sessionID: "s1" }, { args: { description: "repair" } })
  expectGuardThrow(
    () => guard.before({ tool: "subagent", sessionID: "s1" }, { args: { description: "final review" } }),
    GUARD_ERROR_CODES.DELEGATION_LIMIT_EXCEEDED,
    /exceeded the configured 3 subagent delegation ceiling/,
  )
})

test("bounds V2 subagent fan-out independently of total tool calls", () => {
  const guard = createTurnGuard({ maxToolCalls: 20, maxDelegations: 1, maxIdenticalMutations: 4 })
  guard.before({ tool: "subagent", sessionID: "s1" }, { args: { description: "build" } })
  expectGuardThrow(
    () => guard.before({ tool: "subagent", sessionID: "s1" }, { args: { description: "review" } }),
    GUARD_ERROR_CODES.DELEGATION_LIMIT_EXCEEDED,
    /exceeded the configured 1 subagent delegation ceiling/,
  )
})

test("trips on repeated identical mutation/delegation actions, not repeated reads, with a machine-readable code", () => {
  const guard = createTurnGuard({ maxToolCalls: 20, maxDelegations: 20, maxIdenticalMutations: 2 })
  guard.before({ tool: "read", sessionID: "s1" }, { args: { filePath: "a" } })
  guard.before({ tool: "read", sessionID: "s1" }, { args: { filePath: "a" } })
  guard.before({ tool: "bash", sessionID: "s1" }, { args: { command: "npm test" } })
  guard.before({ tool: "bash", sessionID: "s1" }, { args: { command: "npm test" } })
  expectGuardThrow(
    () => guard.before({ tool: "bash", sessionID: "s1" }, { args: { command: "npm test" } }),
    GUARD_ERROR_CODES.REPEATED_MUTATION,
    /same bash action/,
  )
})

test("resets only the selected session", () => {
  const guard = createTurnGuard({ maxToolCalls: 1, maxDelegations: 1, maxIdenticalMutations: 1 })
  guard.before({ tool: "read", sessionID: "s1" }, { args: {} })
  guard.before({ tool: "read", sessionID: "s2" }, { args: {} })
  guard.reset("s1")
  assert.doesNotThrow(() => guard.before({ tool: "read", sessionID: "s1" }, { args: {} }))
  expectGuardThrow(
    () => guard.before({ tool: "read", sessionID: "s2" }, { args: {} }),
    GUARD_ERROR_CODES.TOOL_CALL_LIMIT_EXCEEDED,
    /exceeded 1 tool calls/,
  )
})

test('Harness no-progress guard survives status/checkpoint and permits blocker recording', async () => {
  const guard = createTurnGuard()
  let calls = 0
  const args = { action: 'bind_pr', candidate_id: 'c2' }
  const fail = () => { calls++; throw new Error('already bound') }
  for (let n = 0; n < 2; n++) {
    await assert.rejects(guard.runHarness('s', 'harness_execution_controller', args, fail), /already bound/)
    await guard.runHarness('s', 'harness_execution_controller', { action: 'status' }, async () => ({}))
    await guard.runHarness('s', 'harness_execution_controller', { action: 'checkpoint' }, async () => ({ commit_status: 'committed' }))
  }
  await assert.rejects(guard.runHarness('s', 'harness_execution_controller', args, fail), { code: 'HARNESS_NO_PROGRESS' })
  assert.equal(calls, 2)
  await guard.runHarness('s', 'harness_execution_controller', { action: 'block' }, async () => ({ commit_status: 'committed' }))
  await guard.runHarness('s', 'harness_execution_controller', { action: 'clear_blocker' }, async () => ({ commit_status: 'committed' }))
  await assert.rejects(guard.runHarness('s', 'harness_execution_controller', args, fail), /already bound/)
})

test('Harness no-progress guard isolates sessions and does not trip on successful retries', async () => {
  const guard = createTurnGuard()
  for (let n = 0; n < 8; n++) await guard.runHarness('s', 'harness_merge_candidate', { candidate_id: 'c1' }, async () => ({ status: 'already_verified' }))
  const fail = async () => { throw new Error('drift') }
  for (let n = 0; n < 2; n++) await assert.rejects(guard.runHarness('s', 'harness_merge_candidate', { candidate_id: 'c2' }, fail))
  await assert.rejects(guard.runHarness('other', 'harness_merge_candidate', { candidate_id: 'c2' }, fail), /drift/)
  guard.reset('s')
  await assert.rejects(guard.runHarness('s', 'harness_merge_candidate', { candidate_id: 'c2' }, fail), /drift/)
})

test("external progress permits retry without resetting the guard", async () => {
  const guard = createTurnGuard()
  let observed = "CI_PENDING"
  let calls = 0
  const run = () => guard.runHarness("s", "harness_merge_candidate", { candidate_id: "c" }, async () => {
    calls++
    if (observed === "CI_PENDING") throw new Error("CI pending")
    return { status: "merged" }
  }, async () => ({ checks: observed }))
  await assert.rejects(run(), /CI pending/)
  await assert.rejects(run(), /CI pending/)
  await assert.rejects(run(), /without progress/)
  assert.equal(calls, 2)
  observed = "CI_SUCCESS"
  assert.equal((await run()).status, "merged")
  assert.equal(calls, 3)
})
