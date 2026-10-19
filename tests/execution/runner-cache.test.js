import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classifyRunnerFailure, runnerEnvironment, sanitizedEnv } from "../../src/execution/verification.js"

test("cache is runner-owned and absent from the frozen candidate unless explicitly enabled", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "candidate-"))
  try {
    const off = await runnerEnvironment(workspace, "npm", { enableCache: false })
    assert.deepEqual(off, sanitizedEnv(workspace))
    assert.equal(off.npm_config_cache, undefined)
    const enabled = await runnerEnvironment(workspace, "npm", { enableCache: true })
    assert.match(enabled.npm_config_cache, /harness-npm-cache-/)
    assert.notEqual(enabled.npm_config_cache, workspace)
    const again = await runnerEnvironment(workspace, "npm", { enableCache: true })
    assert.equal(enabled.npm_config_cache, again.npm_config_cache)
    assert.equal((await runnerEnvironment(workspace, "node", { enableCache: true })).npm_config_cache, undefined)
    assert.equal(enabled.HOME, workspace)
    assert.equal(enabled.TMPDIR, workspace)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test("npm stderr classifies cause without claiming tests passed or changing the contract", () => {
  assert.deepEqual(classifyRunnerFailure("npm error code EACCES"), { kind: "RUNNER_SETUP", code: "NPM_PERMISSION" })
  assert.deepEqual(classifyRunnerFailure("npm ERR! code ENOTFOUND"), { kind: "NETWORK", code: "NPM_DNS" })
  assert.deepEqual(classifyRunnerFailure("npm ERR! code ETIMEDOUT"), { kind: "NETWORK", code: "NPM_TRANSPORT" })
  assert.deepEqual(classifyRunnerFailure("npm ERR! code EINTEGRITY"), { kind: "RUNNER_SETUP", code: "NPM_CACHE_INTEGRITY" })
  assert.deepEqual(classifyRunnerFailure("npm error code EUSAGE"), { kind: "RUNNER_SETUP", code: "NPM_LOCKFILE" })
  assert.deepEqual(classifyRunnerFailure("test failed for another reason"), { kind: "UNKNOWN", code: "UNCLASSIFIED" })
})
