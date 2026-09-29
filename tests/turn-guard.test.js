import test from "node:test"
import assert from "node:assert/strict"
import { createTurnGuard, readGuardSettings } from "../src/turn-guard.js"

test("applies defaults and ignores invalid limit overrides", () => {
  assert.deepEqual(readGuardSettings({ HARNESS_MAX_TOOL_CALLS: "0" }), {
    maxToolCalls: 40,
    maxDelegations: 3,
    maxIdenticalMutations: 4,
    maxOutputTokens: 4096,
  })
})

test("stops tool actions after the configured per-turn ceiling", () => {
  const guard = createTurnGuard({ maxToolCalls: 2, maxDelegations: 4, maxIdenticalMutations: 4 })
  guard.before({ tool: "read", sessionID: "s1" }, { args: { filePath: "a" } })
  guard.before({ tool: "read", sessionID: "s1" }, { args: { filePath: "b" } })
  assert.throws(() => guard.before({ tool: "read", sessionID: "s1" }, { args: {} }), /exceeded 2 tool calls/)
})

test("bounds V2 subagent fan-out independently of total tool calls", () => {
  const guard = createTurnGuard({ maxToolCalls: 20, maxDelegations: 1, maxIdenticalMutations: 4 })
  guard.before({ tool: "subagent", sessionID: "s1" }, { args: { description: "build" } })
  assert.throws(() => guard.before({ tool: "subagent", sessionID: "s1" }, { args: { description: "review" } }), /exceeded 1 subagent delegations/)
})

test("trips on repeated identical mutation/delegation actions, not repeated reads", () => {
  const guard = createTurnGuard({ maxToolCalls: 20, maxDelegations: 20, maxIdenticalMutations: 2 })
  guard.before({ tool: "read", sessionID: "s1" }, { args: { filePath: "a" } })
  guard.before({ tool: "read", sessionID: "s1" }, { args: { filePath: "a" } })
  guard.before({ tool: "bash", sessionID: "s1" }, { args: { command: "npm test" } })
  guard.before({ tool: "bash", sessionID: "s1" }, { args: { command: "npm test" } })
  assert.throws(() => guard.before({ tool: "bash", sessionID: "s1" }, { args: { command: "npm test" } }), /same bash action/)
})

test("resets only the selected session", () => {
  const guard = createTurnGuard({ maxToolCalls: 1, maxDelegations: 1, maxIdenticalMutations: 1 })
  guard.before({ tool: "read", sessionID: "s1" }, { args: {} })
  guard.before({ tool: "read", sessionID: "s2" }, { args: {} })
  guard.reset("s1")
  assert.doesNotThrow(() => guard.before({ tool: "read", sessionID: "s1" }, { args: {} }))
  assert.throws(() => guard.before({ tool: "read", sessionID: "s2" }, { args: {} }), /exceeded 1 tool calls/)
})
