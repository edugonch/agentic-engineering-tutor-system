// Adversarial incident analog: three separate verified WU merges, a fourth
// active WU, a stale canonical Git checkout, and an OpenCode session moved into
// a clean linked recovery worktree. Historical candidate/controller files stay
// in the canonical project root; Git proof MUST use session worktree.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createExecutionController } from "../../src/execution/execution.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()

async function setupFourWu(t, { includeNext = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-multi-worktree-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  git(root, "init", "-q")
  git(root, "config", "user.name", "Harness negative tests")
  git(root, "config", "user.email", "harness@example.invalid")
  await mkdir(join(root, "docs"), { recursive: true })
  await writeFile(join(root, "README.md"), "Foundational readme\n")
  git(root, "add", "README.md")
  git(root, "commit", "-qm", "foundation")
  const controller = await createExecutionController({ dir: join(root, ".harness/execution/controller/E") })
  const registry = createCandidateRegistry({ dir: join(root, ".harness/execution") })
  const commit = async (operation_type, body) => {
    const lease = await controller.acquire("root")
    const { state } = await controller.snapshot()
    return controller.commit({
      operation_id: `fourwu:${state.revision}:${operation_type}`, operation_type, body,
    }, {
      holder_session_id: "root", expected_revision: state.revision,
      lease_fencing_token: lease.fencing_token,
    })
  }
  await commit("MANDATE_APPROVE", {
    execution_id: "E:exec", mandate_id: "M", total_seconds: 259200, max_wus: includeNext ? 5 : 4,
    merge_policy: "governed_auto", required_ci_checks: [],
    wu_sequence: [...["E05-01-E", "E05-02-E", "E05-03-E", "E05-04-E"], ...(includeNext ? ["E05-05-E"] : [])],
    authority_kind: "OWNER_APPROVED_EPIC",
    source_artifact_id: "EPIC-05-APPROVED", source_record_key: "record-epic",
    source_hash: "0123456789abcdef".repeat(4),
  })
  const recorded = []
  for (const [index, wu] of ["E05-01-E", "E05-02-E", "E05-03-E"].entries()) {
    const path = `docs/predecessor-${index + 1}.md`
    await writeFile(join(root, path), `# Approved ${wu}\n`)
    git(root, "add", path)
    git(root, "commit", "-qm", `merge ${wu}`)
    const sha = git(root, "rev-parse", "HEAD")
    const candidate = await freezeCandidate(root, { paths: [path] })
    await registry.store(candidate)
    await commit("WU_ACTIVATE", { wu_id: wu, mandate_id: "M" })
    await commit("FREEZE_CANDIDATE", {
      wu_id: wu, candidate_id: candidate.candidate_id,
      manifest_hash: candidate.manifest_hash, tree_hash: candidate.tree_hash,
    })
    await commit("RECORD_REVIEW", {
      candidate_id: candidate.candidate_id, verdict: "PASS",
      candidate_hashes: { manifest_hash: candidate.manifest_hash, tree_hash: candidate.tree_hash },
      verification_evidence_ids: ["verified-evidence"], verified_check_ids: [], verification_contract_hash: null,
    })
    await commit("BIND_PR", { candidate_id: candidate.candidate_id, repository: "example/alfran",
      pr_number: 215 + index, head_sha: sha, base_sha: sha, base_branch: "main" })
    await commit("MERGE_START", {})
    await commit("MERGE_RECORD", { merge_commit_sha: sha, merged_head_sha: sha })
    await commit("MERGE_VERIFY", {})
    await commit("WU_COMPLETE", { candidate_id: candidate.candidate_id })
    recorded.push({ wu, path, sha, candidate_id: candidate.candidate_id })
  }
  await commit("WU_ACTIVATE", { wu_id: "E05-04-E", mandate_id: "M" })
  await commit("BLOCK", {
    class: "BLOCKED_SCOPE",
    reason: "docs/predecessor-2.md and docs/predecessor-3.md were reported UNTRACKED in stale worktree",
  })
  const blocked = (await controller.snapshot()).state
  const verifiedHead = recorded.at(-1).sha

  // The plugin canonical checkout is now different from the session checkout.
  // The git common-dir must remain identical (real linked worktree, not a clone).
  await writeFile(join(root, "canonical-only.txt"), "canonical drift, not active WU\n")
  git(root, "add", "canonical-only.txt")
  git(root, "commit", "-qm", "canonical checkout diverged after session move")
  const recoveryRoot = join(root, "recovery-wt")
  git(root, "worktree", "add", "-q", "--detach", recoveryRoot, verifiedHead)

  return { root, recoveryRoot, controller, registry, recorded, blocked, verifiedHead, commit }
}

test("RED multi-WU: moved session clean at WU-03 merge must reconcile via canonical controller and session Git root", async t => {
  const f = await setupFourWu(t)
  const statusBefore = await f.controller.snapshot()
  const report = await runExecutionController(f.root, {
    action: "inspect_scope_worktree", execution_id: "E", session_id: "root",
  }, f.registry, { checkoutRoot: f.recoveryRoot })
  assert.equal(report.status, "VERIFIED_RECONCILABLE")
  assert.equal(report.proof.head_sha, f.verifiedHead)
  assert.equal(await realpath(report.proof.checkout_root), await realpath(f.recoveryRoot))
  assert.deepEqual(report.proof.predecessor_files.map(x => x.path), f.recorded.map(x => x.path))
  assert.equal((await f.controller.snapshot()).state.revision, statusBefore.state.revision)
  const result = await runExecutionController(f.root, {
    action: "reconcile_stale_worktree_scope", execution_id: "E", session_id: "root",
    expected_revision: statusBefore.state.revision,
    blocked_at_revision: statusBefore.state.blocker.at_revision,
  }, f.registry, { checkoutRoot: f.recoveryRoot })
  assert.equal(result.blocker, null)
  assert.equal(result.wu.wu_id, "E05-04-E")
  assert.equal(result.wu.completed, false)
  assert.equal(result.budget.total_seconds, 259200)
  assert.equal(result.budget.used_seconds, statusBefore.state.budget.used_seconds)
  assert.equal((await f.controller.snapshot()).events.filter(x => x.operation_type === "SCOPE_WORKTREE_RECONCILE").length, 1)
})

test("RED multi-WU negative: checkout at wrong HEAD cannot clear a valid historical blocker", async t => {
  const f = await setupFourWu(t)
  const report = await runExecutionController(f.root, {
    action: "inspect_scope_worktree", execution_id: "E", session_id: "root",
  }, f.registry, { checkoutRoot: f.root })
  assert.equal(report.status, "NOT_VERIFIED")
  assert.match(report.reason, /SCOPE_RECOVERY_HEAD/)
  assert.equal((await f.controller.snapshot()).state.blocker.class, "BLOCKED_SCOPE")
})


test("adversarial lifecycle: recovery -> candidate from moved checkout -> independently gated WU closure -> next frozen activation", async t => {
  const f = await setupFourWu(t, { includeNext: true })
  const before = await f.controller.snapshot()
  const recovery = await runExecutionController(f.root, {
    action: "reconcile_stale_worktree_scope", execution_id: "E", session_id: "root",
    expected_revision: before.state.revision, blocked_at_revision: before.state.blocker.at_revision,
  }, f.registry, { checkoutRoot: f.recoveryRoot })
  assert.equal(recovery.blocker, null)

  // The actual fourth-WU document exists only in the moved checkout; the
  // canonical controller and candidate registry must retain exact identities.
  const document = "docs/state-transition-contract.md"
  await writeFile(join(f.recoveryRoot, document), "# E05-04 owner policy + delegated technical transitions\n")
  git(f.recoveryRoot, "add", document)
  git(f.recoveryRoot, "commit", "-qm", "E05-04 documentary candidate")
  const head = git(f.recoveryRoot, "rev-parse", "HEAD")
  const candidate = await freezeCandidate(f.recoveryRoot, { paths: [document] })
  await f.registry.store(candidate)
  await f.commit("FREEZE_CANDIDATE", {
    candidate_id: candidate.candidate_id, wu_id: "E05-04-E",
    manifest_hash: candidate.manifest_hash, tree_hash: candidate.tree_hash,
  })
  await assert.rejects(f.commit("WU_COMPLETE", { candidate_id: candidate.candidate_id }), /no review/)
  await assert.rejects(f.commit("WU_ACTIVATE", { wu_id: "E05-05-E", mandate_id: "M" }), /not complete/)

  // Pure state-machine fixture: this review/merge evidence is synthetic to
  // validate ordering only, NOT a real OpenCode reviewer/verification receipt.
  await f.commit("RECORD_REVIEW", {
    candidate_id: candidate.candidate_id, verdict: "PASS",
    candidate_hashes: { manifest_hash: candidate.manifest_hash, tree_hash: candidate.tree_hash },
    verification_evidence_ids: ["synthetic-state-fixture"], verified_check_ids: [],
    verification_contract_hash: null,
  })
  await assert.rejects(f.commit("WU_COMPLETE", { candidate_id: candidate.candidate_id }), /merge candidate .* does not match|merge.status VERIFIED/)
  await f.commit("BIND_PR", {
    candidate_id: candidate.candidate_id, repository: "example/alfran",
    pr_number: 218, head_sha: head, base_sha: f.verifiedHead, base_branch: "main",
  })
  await f.commit("MERGE_START", {})
  await f.commit("MERGE_RECORD", { merge_commit_sha: head, merged_head_sha: head })
  await f.commit("MERGE_VERIFY", {})
  await f.commit("WU_COMPLETE", { candidate_id: candidate.candidate_id })
  const successor = await f.commit("WU_ACTIVATE", { wu_id: "E05-05-E", mandate_id: "M" })
  const state = (await f.controller.snapshot()).state
  assert.equal(state.wu.wu_id, "E05-05-E")
  assert.equal(state.activated_wu_ids.length, 5)
  assert.equal(state.completed_wus["E05-04-E"].candidate_id, candidate.candidate_id)
  assert.equal(state.blocker, null)
  assert.equal(state.budget.total_seconds, 259200)
  assert.equal(state.budget.used_seconds, before.state.budget.used_seconds)
  assert.ok(successor)
  const loaded = await f.registry.load(candidate.candidate_id)
  assert.equal(loaded.overlay.find(entry => entry.path === document)?.path, document)
  const verify = await runExecutionController(f.root, { action: "verify", execution_id: "E", session_id: "root" }, f.registry)
  assert.equal(verify.passed, true)
})
