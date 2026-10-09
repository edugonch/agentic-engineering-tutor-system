import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createExecutionController } from "../../src/execution/execution.js"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { candidateGitTree } from "../../src/execution/git-tree.js"
import { createLaunchBindingRegistry } from "../../src/execution/launch-binding.js"
import { budgetStatus, evaluateReadiness } from "../../src/execution/readiness.js"
import { createGitHubAdapter } from "../../src/execution/github-adapter.js"

test("F15: alteration of a durable event is rejected before projection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "integrity-"))
  try {
    const c = await createExecutionController({ dir })
    const lease = await c.acquire("owner")
    await c.commit({ operation_id: "one", operation_type: "CHECKPOINT", body: { note: "original" } },
      { holder_session_id: "owner", expected_revision: 0, lease_fencing_token: lease.fencing_token })
    const path = join(dir, "events.ndjson")
    await writeFile(path, (await readFile(path, "utf8")).replace("original", "tampered"))
    await assert.rejects(c.snapshot(), /integrity mismatch/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("F19: completion rejects new work but retains idempotent completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "complete-"))
  try {
    const c = await createExecutionController({ dir })
    const commit = async (operation_type, body) => {
      const lease = await c.acquire("owner")
      const { state } = await c.snapshot()
      return c.commit({ operation_id: operation_type, operation_type, body },
        { holder_session_id: "owner", expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
    }
    await commit("MANDATE_APPROVE", { mandate_id: "m", max_wus: 1, total_seconds: 100 })
    await commit("COMPLETE", {})
    assert.equal((await commit("COMPLETE", {})).status, "replayed")
    await assert.rejects(commit("DISPATCH_RESERVE", { dispatch_id: "d", reserved_seconds: 10 }), /completed/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("F02: candidate tree equals Git for nesting, executable modes, UTF8 and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-tree-"))
  try {
    await mkdir(join(root, "foo"))
    for (const [path, text] of [["foo/a", "nested"], ["foo.bar", "sibling"], ["é.txt", "bytes\0x"], ["run", "#!/bin/sh\n"]]) await writeFile(join(root, path), text)
    await chmod(join(root, "run"), 0o755)
    await symlink("foo/a", join(root, "link"))
    const candidate = await freezeCandidate(root, { paths: ["foo/a", "foo.bar", "é.txt", "run", "link"] })
    execFileSync("git", ["init", "-q"], { cwd: root })
    execFileSync("git", ["add", "."], { cwd: root })
    assert.equal(candidateGitTree(candidate), execFileSync("git", ["write-tree"], { cwd: root, encoding: "utf8" }).trim())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("F07: release clears only the exact pending binding", () => {
  const r = createLaunchBindingRegistry()
  r.set("s", "builder", { execution_id: "e", dispatch_id: "d" })
  r.set("s", "reviewer", { execution_id: "e", dispatch_id: "r" })
  r.release("e", "d")
  assert.equal(r.consume("s", "builder"), undefined)
  assert.equal(r.peek("s", "reviewer").dispatch_id, "r")
})

test("F11: absent probes and zero/unknown budget cannot report READY", async () => {
  assert.equal(budgetStatus({ remaining: 0 }).status, "BLOCKED_BUDGET")
  assert.equal(budgetStatus({ remaining: Infinity }).status, "BLOCKED_BUDGET")
  assert.equal((await evaluateReadiness([{ capability: "workspace" }], async () => undefined)).status, "BLOCKED_CAPABILITY")
})

test("F14: newest CI attempt wins regardless of response order; app collisions fail closed", async () => {
  const runs = [{ id: 30, name: "test", conclusion: "success", app: { id: 1 } }, { id: 20, name: "test", conclusion: "failure", app: { id: 1 } }]
  const adapter = createGitHubAdapter({ fetchImpl: async () => ({ ok: true, json: async () => ({ check_runs: runs }) }) })
  const query = { repository: "o/r", head_sha: "h", check_names: ["test"] }
  assert.equal((await adapter.getChecks(query))[0].conclusion, "success")
  runs.push({ id: 40, name: "test", conclusion: "success", app: { id: 2 } })
  assert.equal((await adapter.getChecks(query))[0].conclusion, null)
})
