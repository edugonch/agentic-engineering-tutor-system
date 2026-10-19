import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

test("distribution canary: package includes runtime changes and no machine-specific npmrc", () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root, encoding: "utf8", timeout: 30000,
  })
  assert.equal(r.status, 0, r.stderr)
  const files = JSON.parse(r.stdout)[0].files.map(file => file.path)
  for (const expected of [
    "index.js",
    "src/execution/controller-tool.js",
    "src/execution/controller-preflight.js",
    "src/execution/controller-response.js",
    "src/execution/attempt-policy.js",
    "src/execution/efficiency-telemetry.js",
    "src/execution/review-handoff.js",
    "src/trusted-approvals.js",
    "templates/.opencode/agents/harness-orchestrator.md",
    "templates/.opencode/agents/harness-builder.md",
    "templates/.opencode/agents/harness-reviewer.md",
  ]) assert.ok(files.includes(expected), "missing from installable package: " + expected)
  assert.equal(files.includes(".npmrc"), false)
})
