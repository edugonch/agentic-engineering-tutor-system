// Regression for E05-19-E: recover STARTED without reviving stale merge authority.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { runMergeCandidate } from "../../src/execution/merge.js"
import { candidateGitTree } from "../../src/execution/git-tree.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { createVerificationReceipt, writeVerificationReceipt } from "../../src/execution/verification-results.js"
import { seedWuContract } from "./wu-fixture.js"

const sid = "session-original"
const dirFor = root => join(root, ".harness", "execution", "controller", "E1")
const leasePath = root => join(dirFor(root), "lease.json")
const tree = () => candidateGitTree({
  overlay: [{ path: "change.txt", mode: "100644", type: "file", content: Buffer.from("hello").toString("base64") }],
})

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-merge-lease-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

function adapterFor({ merged = false, head = "head-a", base = "base-1", branch = "main" } = {}) {
  let remoteMerged = merged
  let mergeCalls = 0
  return {
    get mergeCalls() { return mergeCalls },
    getCommitTree: async () => tree(),
    getPullRequest: async () => ({
      state: remoteMerged ? "closed" : "open",
      merged: remoteMerged,
      head_sha: head, base_sha: base, base_branch: branch,
      merge_commit_sha: remoteMerged ? "merge-1" : null,
    }),
    getChecks: async ({ check_names }) => check_names.map(name => ({ name, conclusion: "SUCCESS" })),
    merge: async () => {
      mergeCalls++
      remoteMerged = true
      return { merged: true, merge_commit_sha: "merge-1" }
    },
  }
}

async function setupStarted(root) {
  await recordKnowledgeArtifact(root, {
    artifact_type: "epic", artifact_id: "epic-001", status: "APPROVED", owner_confirmed: true,
    title: "Lease recovery test",
    content: "test epic\nexecution_mandate: " + JSON.stringify({
      max_wus: 4, total_seconds: 100, merge_policy: "governed_auto",
      required_ci_checks: ["check-1"],
    }),
    source_refs: ["https://example.com/epic-source"],
  })
  await runExecutionController(root, {
    action: "approve_mandate", execution_id: "E1", session_id: sid, epic_artifact_id: "epic-001",
  })
  await seedWuContract(root)
  await runExecutionController(root, {
    action: "activate_wu", execution_id: "E1", session_id: sid,
    wu_id: "WU-01", mandate_id: "E1-MANDATE-001",
  })
  await writeFile(join(root, "change.txt"), "hello")
  const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })
  const candidate = await freezeCandidate(root, {
    paths: ["change.txt"],
    verification_contract: {
      commands: [{ id: "check-1", program: "node", args: ["-e", "process.exit(0)"] }],
      environment: { network_policy: "UNRESTRICTED" }, source_wu_id: "WU-01",
    },
  })
  await registry.store(candidate)
  await runExecutionController(root, {
    action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id,
  })
  const evidence = await writeVerificationReceipt(
    join(root, ".harness", "execution", "verification-results"),
    createVerificationReceipt({
      candidate_id: candidate.candidate_id,
      verification_contract_hash: candidate.manifest.verification_contract.contract_hash,
      check_id: "check-1", status: "PASS", exitCode: 0,
      fingerprint: { node: "test", cwd: "/tmp", timestamp: new Date().toISOString() },
    }),
  )
  await runExecutionController(root, {
    action: "record_review", execution_id: "E1", session_id: sid,
    candidate_id: candidate.candidate_id, verdict: "PASS",
    reviewer: "harness-reviewer", verification_evidence_ids: [evidence],
  })
  await runExecutionController(root, {
    action: "bind_pr", execution_id: "E1", session_id: sid,
    repository: "owner/repo", pr_number: 158, candidate_id: candidate.candidate_id,
    head_sha: "head-a", base_branch: "main", base_sha: "base-1",
  })
  await runExecutionController(root, {
    action: "record_ci", execution_id: "E1", session_id: sid,
    candidate_id: candidate.candidate_id, head_sha: "head-a",
    check_identity: "check-1", conclusion: "SUCCESS",
  })

  const controller = await createExecutionController({ dir: dirFor(root), lease_ttl_ms: 30000 })
  const lease = await controller.acquire(sid)
  const snapshot = await controller.snapshot()
  await controller.commit({
    operation_id: "seed:merge-start", operation_type: "MERGE_START",
    body: { attempt_id: "E05-19-E-recovery" },
  }, {
    holder_session_id: sid, expected_revision: snapshot.state.revision,
    lease_fencing_token: lease.fencing_token,
  })
  assert.equal((await controller.snapshot()).state.merge.status, "STARTED")
  return { candidate_id: candidate.candidate_id, controller }
}

// Expiry is modeled by advancing the durable lease's expiry, not by sleeping.
// No historical event or governed receipt is edited.
async function expireLease(root) {
  const lease = JSON.parse(await readFile(leasePath(root), "utf8"))
  await writeFile(leasePath(root), JSON.stringify({ ...lease, expires_at: 0 }) + "\n")
  return lease.fencing_token
}

test("STARTED with expired lease safely acquires authority and merges once", async () => {
  await withRoot(async root => {
    const { candidate_id, controller } = await setupStarted(root)
    const oldToken = await expireLease(root)
    const adapter = adapterFor()
    const result = await runMergeCandidate(root, { candidate_id, session_id: sid, adapter })
    assert.equal(result.status, "merged")
    assert.equal(adapter.mergeCalls, 1)
    const snap = await controller.snapshot()
    assert.equal(snap.state.merge.status, "VERIFIED")
    assert.equal(snap.lease.fencing_token, oldToken + 1)
  })
})

test("STARTED survives restart and recovers with a new session", async () => {
  await withRoot(async root => {
    const { candidate_id, controller } = await setupStarted(root)
    const oldToken = await expireLease(root)
    const adapter = adapterFor()
    const result = await runMergeCandidate(root, { candidate_id, session_id: "session-recovered", adapter })
    assert.equal(result.status, "merged")
    assert.equal(adapter.mergeCalls, 1)
    const snap = await controller.snapshot()
    assert.equal(snap.lease.holder_session_id, "session-recovered")
    assert.equal(snap.lease.fencing_token, oldToken + 1)
  })
})

test("STARTED rejects a different session while the previous lease is valid", async () => {
  await withRoot(async root => {
    const { candidate_id } = await setupStarted(root)
    const adapter = adapterFor()
    await assert.rejects(
      runMergeCandidate(root, { candidate_id, session_id: "session-intruder", adapter }),
      /lease is held by session/,
    )
    assert.equal(adapter.mergeCalls, 0)
  })
})

test("guardedEffect rejects an old token even when the session identifier is reused", async () => {
  await withRoot(async root => {
    let clock = 0
    const controller = await createExecutionController({ root, now: () => clock, lease_ttl_ms: 1000 })
    const original = await controller.acquire(sid)
    clock = 2000
    const renewed = await controller.acquire(sid)
    assert.equal(renewed.fencing_token, original.fencing_token + 1)
    let effects = 0
    const invocation = token => controller.guardedEffect({
      holder_session_id: sid, expected_revision: 0, lease_fencing_token: token,
      validate: () => {}, effect: async () => { effects++; return "remote-effect" },
    })
    await assert.rejects(invocation(original.fencing_token), /Stale fencing token/)
    await assert.rejects(invocation(undefined), /requires lease_fencing_token/)
    assert.equal(effects, 0)
    assert.equal(await invocation(renewed.fencing_token), "remote-effect")
    assert.equal(effects, 1)
  })
})

test("STARTED recovery cannot bypass an unresolved blocker, even for a merged PR", async () => {
  await withRoot(async root => {
    const { candidate_id, controller } = await setupStarted(root)
    await runExecutionController(root, {
      action: "block", execution_id: "E1", session_id: sid,
      class: "BLOCKED_TOOLING", reason: "merge lease recovery unresolved",
    })
    const adapter = adapterFor({ merged: true })
    await assert.rejects(
      runMergeCandidate(root, { candidate_id, session_id: sid, adapter }),
      /unresolved blocker BLOCKED_TOOLING/,
    )
    assert.equal(adapter.mergeCalls, 0)
    assert.equal((await controller.snapshot()).state.merge.status, "STARTED")
  })
})

test("STARTED reconciliation after expiry records a remotely merged PR without a second merge", async () => {
  await withRoot(async root => {
    const { candidate_id, controller } = await setupStarted(root)
    await expireLease(root)
    const adapter = adapterFor({ merged: true })
    const result = await runMergeCandidate(root, { candidate_id, session_id: sid, adapter })
    assert.equal(result.status, "recovered_existing_merge")
    assert.equal(adapter.mergeCalls, 0)
    const snap = await controller.snapshot()
    assert.equal(snap.state.merge.status, "VERIFIED")
    assert.equal(snap.state.merge.merge_commit_sha, "merge-1")
    const second = await runMergeCandidate(root, { candidate_id, session_id: sid, adapter })
    assert.equal(second.status, "already_verified")
    assert.equal(adapter.mergeCalls, 0)
  })
})

test("STARTED rejects remote head, base SHA, and base branch drift", async () => {
  for (const drift of [{ head: "unexpected" }, { base: "unexpected" }, { branch: "unexpected" }]) {
    await withRoot(async root => {
      const { candidate_id, controller } = await setupStarted(root)
      await expireLease(root)
      const adapter = adapterFor(drift)
      await assert.rejects(
        runMergeCandidate(root, { candidate_id, session_id: sid, adapter }),
        /drifted/,
      )
      assert.equal(adapter.mergeCalls, 0)
      assert.equal((await controller.snapshot()).state.merge.status, "STARTED")
    })
  }
})

test("PR binding cannot be replaced during unresolved STARTED merge", async () => {
  await withRoot(async root => {
    const { candidate_id, controller } = await setupStarted(root)
    await assert.rejects(
      runExecutionController(root, {
        action: "bind_pr", execution_id: "E1", session_id: sid,
        repository: "owner/repo", pr_number: 158, candidate_id,
        head_sha: "changed-head", base_branch: "main", base_sha: "base-1",
      }),
      /already bound|merge in progress/,
    )
    assert.equal((await controller.snapshot()).state.pr_binding.head_sha, "head-a")
  })
})
