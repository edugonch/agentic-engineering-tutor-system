import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

test("managed orchestrator profile is compact but retains all critical gates", async () => {
  const profile = await readFile(fileURLToPath(new URL(
    "../../templates/.opencode/agents/harness-orchestrator.md", import.meta.url,
  )), "utf8")
  const detailed = await readFile(fileURLToPath(new URL(
    "../../docs/orchestrator-procedures.md", import.meta.url,
  )), "utf8")
  assert.ok(Buffer.byteLength(profile) < 18000, "core instructions are no longer the complete 56 KB playbook")
  assert.ok(Buffer.byteLength(detailed) > 40000, "uncommon procedures remain available on demand")
  for (const rule of [
    "Never edit `events.ndjson`",
    "No concurrent mutating builders",
    "real verification",
    "independent review",
    "governed_auto",
    "configure_wu_batch",
    "batch_coverage_wu_ids",
    "harness_recover_orphan_dispatch",
    "RUNTIME_STABILITY_GUARD",
    "WU_PLANNING_ESTIMATES",
    "harness_check_agent_readiness",
    "BLOCKED_AUTHORITY",
    "harness_retry_blocked_verification",
    "EPIC_REBASE_REQUIRED",
    "source hashes",
    "PROJECT_STATE.md",
  ]) {
    assert.ok(profile.includes(rule), `Missing critical invariant: ${rule}`)
  }
  assert.match(profile, /action: edit\n    resource: "\*"\n    effect: deny/)
  assert.match(profile, /action: subagent\n    resource: harness-builder\n    effect: allow/)
  assert.match(profile, /action: subagent\n    resource: harness-reviewer\n    effect: allow/)
  assert.match(profile, /Do not load that whole reference for ordinary WU delivery/)
})
