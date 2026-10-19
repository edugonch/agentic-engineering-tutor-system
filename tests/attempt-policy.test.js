import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCausalAttemptPolicy } from "../src/execution/attempt-policy.js"

test("causal intent survives a new session and blocks a different artifact ID for the same cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "causal-guard-"))
  try {
    const one = createCausalAttemptPolicy(root, { enabled: true })
    const a = { execution_id: "E05-06-E", action: "correct_verification_contract", decision_artifact_id: "V1" }
    const evidence = { wu: "WU-078", contract: "a".repeat(64) }
    await one.failure(a, evidence, Object.assign(new Error("requires WU artifact"), { code: "MISSING_WU_ARTIFACT_ID" }))
    const two = createCausalAttemptPolicy(root, { enabled: true })
    await assert.rejects(two.before({ ...a, decision_artifact_id: "V2" }, evidence), { code: "NO_PROGRESS_REPAIR_REQUIRED" })
    await assert.doesNotReject(two.before({ ...a, wu_artifact_id: "approved-source" }, evidence))
    await assert.doesNotReject(two.before({ ...a, decision_artifact_id: "V3" }, { ...evidence, contract: "b".repeat(64) }))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("legitimate approved inspection permits correction, and successful mutation clears auxiliary stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "causal-guard-"))
  try {
    const guard = createCausalAttemptPolicy(root, { enabled: true })
    const input = { execution_id: "E", action: "correct_verification_contract", wu_artifact_id: "X" }
    const ev = { contract: "orig" }
    await guard.failure(input, ev, new Error("Delegated correction must preserve every existing check, setup and capability"))
    await assert.rejects(guard.before({ ...input, wu_artifact_id: "Y" }, ev), { code: "NO_PROGRESS_REPAIR_REQUIRED" })
    await guard.success({ ...input, action: "inspect_verification_correction" }, { status: "ADMISSIBLE_READ_ONLY" })
    await assert.doesNotReject(guard.before(input, ev))
    await guard.success(input, { commit_status: "committed" })
    assert.equal(await guard.read(input), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("guard is disabled by default; unrelated external failures do not create strategy blocks", async () => {
  const root = await mkdtemp(join(tmpdir(), "causal-guard-"))
  try {
    const guard = createCausalAttemptPolicy(root)
    const input = { execution_id: "E", action: "correct_verification_contract" }
    await guard.failure(input, { state: "old" }, new Error("network unavailable"))
    await assert.doesNotReject(guard.before(input, { state: "old" }))
    assert.equal(await guard.read(input), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})
