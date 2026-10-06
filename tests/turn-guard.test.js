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

test("applies defaults and ignores invalid limit overrides", () => {
  assert.deepEqual(readGuardSettings({ HARNESS_MAX_TOOL_CALLS: "0" }), {
    maxToolCalls: 250,
    maxDelegations: null,
    maxIdenticalMutations: 4,
    maxOutputTokens: null,
  })
})

test("delegation ceiling is off by default and does not stop a normal governed flow", () => {
  const guard = createTurnGuard()
  // build → review → repair → review needs 4 delegations; the delegation guard
  // is not a WU budget, so far more must still be allowed.
  for (let i = 0; i < 40; i++) {
    assert.doesNotThrow(() => guard.before({ tool: "subagent", sessionID: "governed" }, { args: { description: `work-${i}` } }))
  }
})

test("tool-call ceiling still trips by default with a machine-readable code", () => {
  const guard = createTurnGuard()
  for (let i = 0; i < 250; i++) guard.before({ tool: "read", sessionID: "reads" }, { args: {} })
  expectGuardThrow(
    () => guard.before({ tool: "read", sessionID: "reads" }, { args: {} }),
    GUARD_ERROR_CODES.TOOL_CALL_LIMIT_EXCEEDED,
    /exceeded 250 tool calls/,
  )
})

test("preserves environment overrides for emergency fuses", () => {
  const settings = readGuardSettings({ HARNESS_MAX_TOOL_CALLS: "41", HARNESS_MAX_DELEGATIONS: "5" })
  assert.equal(settings.maxToolCalls, 41)
  assert.equal(settings.maxDelegations, 5)
  assert.equal(settings.maxIdenticalMutations, 4)
})

test("explicit HARNESS_MAX_DELEGATIONS blocks the next delegation with a machine-readable code", () => {
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

test("stops tool actions after the configured per-turn ceiling", () => {
  const guard = createTurnGuard({ maxToolCalls: 2, maxDelegations: 4, maxIdenticalMutations: 4 })
  guard.before({ tool: "read", sessionID: "s1" }, { args: { filePath: "a" } })
  guard.before({ tool: "read", sessionID: "s1" }, { args: { filePath: "b" } })
  expectGuardThrow(
    () => guard.before({ tool: "read", sessionID: "s1" }, { args: {} }),
    GUARD_ERROR_CODES.TOOL_CALL_LIMIT_EXCEEDED,
    /exceeded 2 tool calls/,
  )
})

test("bounds V2 subagent fan-out independently of total tool calls when an explicit ceiling is set", () => {
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
