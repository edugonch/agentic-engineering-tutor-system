import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createExecutionController } from "../../src/execution/execution.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { inspectStaleWorktreeScope } from "../../src/execution/scope-recovery.js"

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()

async function setup(t, { blockerClass = "BLOCKED_SCOPE", reason = "stale worktree predecessor hash mismatch" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-scope-recovery-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, "init", "-q")
  git(root, "config", "user.email", "harness@example.invalid")
  git(root, "config", "user.name", "Harness test")
  await mkdir(join(root, "docs"), { recursive: true })
  await writeFile(join(root, "docs/pred.md"), "# Approved predecessor output\n")
  await writeFile(join(root, "README.md"), "Fixture\n")
  git(root, "add", "README.md", "docs/pred.md")
  git(root, "commit", "-qm", "verified predecessor merge")
  const head = git(root, "rev-parse", "HEAD")
  const registry = createCandidateRegistry({ dir: join(root, ".harness/execution") })
  const candidate = await freezeCandidate(root, { paths: ["docs/pred.md"] })
  await registry.store(candidate)
  const controller = await createExecutionController({ dir: join(root, ".harness/execution/controller/E") })
  const commit = async (operation_type, body) => {
    const lease = await controller.acquire("root")
    const snap = await controller.snapshot()
    return controller.commit({ operation_id: `test:${snap.state.revision}:${operation_type}`, operation_type, body }, {
      holder_session_id: "root", expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token,
    })
  }
  await commit("MANDATE_APPROVE", {
    execution_id: "E:exec", mandate_id: "M", max_wus: 2, total_seconds: 3600,
    merge_policy: "governed_auto", required_ci_checks: [], wu_sequence: ["WU-PREV", "WU-CURRENT"],
    authority_kind: "OWNER_APPROVED_EPIC", source_artifact_id: "EPIC", source_record_key: "source-key",
    source_hash: "abcdef".repeat(10) + "abcd",
  })
  await commit("WU_ACTIVATE", { wu_id: "WU-PREV", mandate_id: "M" })
  await commit("FREEZE_CANDIDATE", {
    wu_id: "WU-PREV", candidate_id: candidate.candidate_id,
    manifest_hash: candidate.manifest_hash, tree_hash: candidate.tree_hash,
  })
  await commit("RECORD_REVIEW", {
    candidate_id: candidate.candidate_id, verdict: "PASS",
    candidate_hashes: { manifest_hash: candidate.manifest_hash, tree_hash: candidate.tree_hash },
    verification_evidence_ids: ["fixture-verified"], verified_check_ids: [], verification_contract_hash: null,
  })
  await commit("BIND_PR", { candidate_id: candidate.candidate_id, repository: "example/fixture",
    pr_number: 1, head_sha: head, base_branch: "main", base_sha: head })
  await commit("MERGE_START", {})
  await commit("MERGE_RECORD", { merge_commit_sha: head, merged_head_sha: head })
  await commit("MERGE_VERIFY", {})
  await commit("WU_COMPLETE", { candidate_id: candidate.candidate_id })
  await commit("WU_ACTIVATE", { wu_id: "WU-CURRENT", mandate_id: "M" })
  await commit("BLOCK", { class: blockerClass, reason })
  const state = (await controller.snapshot()).state
  const run = (action, params = {}) => runExecutionController(root, { execution_id: "E", session_id: "root", action, ...params }, registry)
  return { root, registry, controller, commit, run, head, candidate, state }
}

test("recover exact stale-worktree scope blocker with verified predecessor commit and bytes", async t => {
  const f = await setup(t)
  const prior = await f.controller.snapshot()
  const inspected = await f.run("inspect_scope_worktree")
  assert.equal(inspected.status, "VERIFIED_RECONCILABLE")
  assert.equal(inspected.proof.head_sha, f.head)
  assert.equal(inspected.proof.predecessor_candidate_id, f.candidate.candidate_id)
  assert.equal(inspected.proof.predecessor_files.length, 1)
  assert.equal((await f.controller.snapshot()).state.revision, prior.state.revision)
  const res = await f.run("reconcile_stale_worktree_scope", {
    expected_revision: prior.state.revision, blocked_at_revision: prior.state.blocker.at_revision,
  })
  assert.equal(res.blocker, null)
  assert.equal(res.last_blocker_resolution.blocked_at_revision, prior.state.blocker.at_revision)
  assert.equal(res.budget.total_seconds, prior.state.budget.total_seconds)
  assert.equal(res.budget.used_seconds, prior.state.budget.used_seconds)
  assert.equal(res.wu.wu_id, "WU-CURRENT")
  assert.equal(res.wu.completed, false)
  const again = await f.run("reconcile_stale_worktree_scope", {
    expected_revision: prior.state.revision, blocked_at_revision: prior.state.blocker.at_revision,
  })
  assert.equal(again.commit_status, "replayed")
  const after = await f.controller.snapshot()
  assert.equal(after.events.filter(e => e.operation_type === "SCOPE_WORKTREE_RECONCILE").length, 1)
  assert.deepEqual(after.events.slice(0, prior.events.length), prior.events)
  assert.equal((await f.run("verify")).passed, true)
})

test("genuine scope, security, stale controller revision and wrong blocker revision remain blocked", async t => {
  const f = await setup(t, { reason: "unauthorized scope expansion requires a new feature" })
  const status = await f.run("status")
  assert.equal((await f.run("inspect_scope_worktree")).status, "NOT_ELIGIBLE")
  await assert.rejects(f.run("reconcile_stale_worktree_scope", {
    expected_revision: status.revision, blocked_at_revision: status.blocker.at_revision,
  }), /genuine scope blocker/)
  assert.equal((await f.run("status")).blocker.class, "BLOCKED_SCOPE")
  const s = await setup(t)
  const blocked = await s.run("status")
  await assert.rejects(s.run("reconcile_stale_worktree_scope", {
    expected_revision: blocked.revision - 1, blocked_at_revision: blocked.blocker.at_revision,
  }), /stale controller revision/)
  await assert.rejects(s.run("reconcile_stale_worktree_scope", {
    expected_revision: blocked.revision, blocked_at_revision: blocked.blocker.at_revision - 1,
  }), /different or genuine/)
  const security = await setup(t, { blockerClass: "BLOCKED_SECURITY" })
  assert.equal((await security.run("inspect_scope_worktree")).status, "NOT_ELIGIBLE")
})

test("dirty tracked checkout and changed predecessor bytes cannot be mistaken for a recovered scope", async t => {
  const f = await setup(t)
  await writeFile(join(f.root, "docs/pred.md"), "Corrupted predecessor output\n")
  const status = await f.run("status")
  const inspected = await f.run("inspect_scope_worktree")
  assert.equal(inspected.status, "NOT_VERIFIED")
  assert.match(inspected.reason, /SCOPE_RECOVERY_DIRTY/)
  await assert.rejects(f.run("reconcile_stale_worktree_scope", {
    expected_revision: status.revision, blocked_at_revision: status.blocker.at_revision,
  }), /SCOPE_RECOVERY_DIRTY/)
  assert.equal((await f.run("status")).blocker.class, "BLOCKED_SCOPE")
})

test("different HEAD is rejected even if predecessor document bytes happen to match", async t => {
  const f = await setup(t)
  await writeFile(join(f.root, "other.txt"), "new unrelated commit\n")
  git(f.root, "add", "other.txt")
  git(f.root, "commit", "-qm", "not the verified merge")
  const inspected = await f.run("inspect_scope_worktree")
  assert.equal(inspected.status, "NOT_VERIFIED")
  assert.match(inspected.reason, /SCOPE_RECOVERY_HEAD/)
  assert.equal((await f.run("status")).blocker.class, "BLOCKED_SCOPE")
})

test("legacy stale-checkout reason is not allowed as a new terminal scope blocker", async t => {
  const f = await setup(t, { blockerClass: "BLOCKED_TOOLING", reason: "worktree requires recovery" })
  const before = await f.controller.snapshot()
  await assert.rejects(f.run("block", { class: "BLOCKED_SCOPE", reason: "stale worktree predecessor hash mismatch" }),
    /SCOPE_WORKTREE_CLASSIFICATION/)
  assert.equal((await f.controller.snapshot()).state.revision, before.state.revision)
})


test("RED incident: historical scope blocker says predecessor file UNTRACKED, not magic worktree phrase", async t => {
  const f = await setup(t, { reason: "docs/pred.md was reported as untracked; prior merged appointment document was allegedly absent from Git" })
  const prior = await f.controller.snapshot()
  const report = await f.run("inspect_scope_worktree")
  // The actual checkout and frozen candidate prove the predecessor is tracked,
  // even though the old blocker uses untracked terminology rather than worktree.
  assert.equal(report.status, "VERIFIED_RECONCILABLE")
  assert.deepEqual(report.proof.predecessor_files.map(x => x.path), ["docs/pred.md"])
  assert.equal((await f.controller.snapshot()).state.revision, prior.state.revision)
})

test("RED classification: a new BLOCKED_SCOPE cannot be created for a mere untracked previous artifact", async t => {
  const f = await setup(t, { blockerClass: "BLOCKED_TOOLING", reason: "worktree recovery pending" })
  const snapshot = await f.controller.snapshot()
  await assert.rejects(f.run("block", {
    class: "BLOCKED_SCOPE",
    reason: "docs/pred.md is untracked in this temporary checkout, despite merged predecessor PR",
  }), /SCOPE_WORKTREE_CLASSIFICATION/)
  assert.deepEqual((await f.controller.snapshot()).events, snapshot.events)
})

test("adversarial safety: a real expansion mentioning worktree evidence is never reclassified as environment-only", async t => {
  const f = await setup(t, { reason: "Actual scope expansion: new feature must be added, worktree docs/pred.md also mentioned" })
  const inspect = await f.run("inspect_scope_worktree")
  assert.equal(inspect.status, "NOT_ELIGIBLE")
  const now = await f.run("status")
  await assert.rejects(f.run("reconcile_stale_worktree_scope", {
    expected_revision: now.revision, blocked_at_revision: now.blocker.at_revision,
  }), /genuine scope blocker/)
  assert.equal((await f.run("status")).blocker.class, "BLOCKED_SCOPE")
})
