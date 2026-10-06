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
