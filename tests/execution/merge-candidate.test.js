import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { runMergeCandidate } from "../../src/execution/merge.js"
import { createGitHubAdapter } from "../../src/execution/github-adapter.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { createVerificationReceipt, writeVerificationReceipt } from "../../src/execution/verification-results.js"

const CONTRACT = {
  commands: [{ id: "check-1", program: "node", args: ["-e", "process.exit(0)"] }],
  environment: { network_policy: "UNRESTRICTED" },
  source_wu_id: "WU-01",
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-merge-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

// A configurable fake GitHubMergePort for the orchestration tests.
function fakeAdapter({ prState = "open", prHead = "head-a", prBase = "base-1", prBaseBranch = "main", merged = false, mergeCommitSha = "merge-1", checks = {}, mergeResult = { merged: true, merge_commit_sha: "merge-1" } } = {}) {
  let mergedNow = merged
  return {
    getPullRequest: async () => ({
      state: mergedNow ? "closed" : prState,
      merged: mergedNow,
      head_sha: prHead,
      base_sha: prBase,
      base_branch: prBaseBranch,
      merge_commit_sha: mergedNow ? mergeCommitSha : null,
    }),
    getChecks: async ({ check_names }) => check_names.map((name) => ({ name, conclusion: checks[name] ?? null })),
    merge: async () => {
      mergedNow = true
      return mergeResult
    },
  }
}

// Set up a fully-gated, merge-ready execution and return its candidate.
async function setupReady(root, sid, { requiredCiChecks = ["check-1"] } = {}) {
  await recordKnowledgeArtifact(root, {
    artifact_type: "epic", artifact_id: "epic-001", status: "APPROVED", owner_confirmed: true,
    title: "Test Epic",
    content: `test epic\nexecution_mandate: ${JSON.stringify({ max_wus: 4, total_seconds: 100, merge_policy: "governed_auto", required_ci_checks: requiredCiChecks })}`,
    source_refs: ["https://example.com/epic-source"],
  })
  await runExecutionController(root, { action: "approve_mandate", execution_id: "E1", session_id: sid, epic_artifact_id: "epic-001" })
  await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })

  await writeFile(join(root, "change.txt"), "hello")
  const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })
  const candidate = await freezeCandidate(root, { paths: ["change.txt"], verification_contract: CONTRACT })
  await registry.store(candidate)
  await runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id })

  const receipt = await writeVerificationReceipt(join(root, ".harness", "execution", "verification-results"), createVerificationReceipt({
    candidate_id: candidate.candidate_id,
    verification_contract_hash: candidate.manifest.verification_contract.contract_hash,
    check_id: "check-1",
    status: "PASS",
    exitCode: 0,
    fingerprint: { node: "test", cwd: "/tmp", timestamp: new Date().toISOString() },
  }))
  await runExecutionController(root, { action: "record_review", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id, verdict: "PASS", reviewer: "harness-reviewer", verification_evidence_ids: [receipt] })

  await runExecutionController(root, { action: "bind_pr", execution_id: "E1", session_id: sid, repository: "owner/repo", pr_number: 158, candidate_id: candidate.candidate_id, head_sha: "head-a", base_branch: "main", base_sha: "base-1" })
  for (const check of requiredCiChecks) {
    await runExecutionController(root, { action: "record_ci", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id, head_sha: "head-a", check_identity: check, conclusion: "SUCCESS" })
  }
  return candidate
}

test("happy path: governed_auto merge reaches merged", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    const candidate = await setupReady(root, sid)
    const adapter = fakeAdapter({ checks: { "check-1": "SUCCESS" } })
    const result = await runMergeCandidate(root, { candidate_id: candidate.candidate_id, adapter, session_id: sid })
    assert.equal(result.status, "merged")
  })
})

test("head drift fails closed", async () => {
  await withRoot(async (root) => {
    const candidate = await setupReady(root, "ses-1")
    const adapter = fakeAdapter({ prHead: "head-DRIFTED", checks: { "check-1": "SUCCESS" } })
    await assert.rejects(
      runMergeCandidate(root, { candidate_id: candidate.candidate_id, adapter, session_id: "ses-1" }),
      /drifted/,
    )
  })
})

test("base drift fails closed", async () => {
  await withRoot(async (root) => {
    const candidate = await setupReady(root, "ses-1")
    const adapter = fakeAdapter({ prBase: "base-DRIFTED" })
    await assert.rejects(
      runMergeCandidate(root, { candidate_id: candidate.candidate_id, adapter, session_id: "ses-1" }),
      /drifted/,
    )
  })
})

test("missing/failed required CI is rejected", async () => {
  await withRoot(async (root) => {
    const candidate = await setupReady(root, "ses-1")
    // getChecks returns null (missing) for the required check
    const adapter = fakeAdapter({ checks: { "check-1": null } })
    await assert.rejects(
      runMergeCandidate(root, { candidate_id: candidate.candidate_id, adapter, session_id: "ses-1" }),
      /not SUCCESS|missing/,
    )
  })
})

test("PR closed without merge fails closed", async () => {
  await withRoot(async (root) => {
    const candidate = await setupReady(root, "ses-1")
    const adapter = fakeAdapter({ prState: "closed", merged: false, checks: { "check-1": "SUCCESS" } })
    await assert.rejects(
      runMergeCandidate(root, { candidate_id: candidate.candidate_id, adapter, session_id: "ses-1" }),
      /closed without merge|not open/,
    )
  })
})

test("recovery: already-merged PR with the expected head records + verifies, never merges twice", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    const candidate = await setupReady(root, sid)
    // PR already merged remotely with the expected head and a merge commit.
    let mergeCalls = 0
    const adapter = {
      getPullRequest: async () => ({ state: "closed", merged: true, head_sha: "head-a", base_sha: "base-1", base_branch: "main", merge_commit_sha: "merge-existing" }),
      getChecks: async ({ check_names }) => check_names.map((n) => ({ name: n, conclusion: "SUCCESS" })),
      merge: async () => { mergeCalls += 1; return { merged: true, merge_commit_sha: "merge-again" } },
    }
    const result = await runMergeCandidate(root, { candidate_id: candidate.candidate_id, adapter, session_id: sid })
    assert.equal(result.status, "recovered_existing_merge")
    assert.equal(mergeCalls, 0) // never a second merge
    assert.equal(result.merge_commit_sha, "merge-existing")
  })
})

test("idempotent: a second merge call after VERIFIED is a no-op", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    const candidate = await setupReady(root, sid)
    const adapter = fakeAdapter({ checks: { "check-1": "SUCCESS" } })
    await runMergeCandidate(root, { candidate_id: candidate.candidate_id, adapter, session_id: sid })
    const again = await runMergeCandidate(root, { candidate_id: candidate.candidate_id, adapter, session_id: sid })
    assert.equal(again.status, "already_verified")
  })
})

// --- adapter credential isolation ---
test("GitHub adapter sends the token only as an Authorization header and never leaks it in errors", async () => {
  const token = "secret-token-123"
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    if (String(url).includes("/merge")) {
      return { ok: false, status: 401, statusText: "Unauthorized" }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const adapter = createGitHubAdapter({ token, baseUrl: "https://api.example.com", fetchImpl })

  await assert.rejects(
    adapter.merge({ repository: "o/r", pr_number: 1, expected_head_sha: "h" }),
    /401/,
  )
  // token appears only in the Authorization header, not in the thrown error
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers.Authorization, `Bearer ${token}`)
  // the error message must not contain the token
  await assert.rejects(
    adapter.merge({ repository: "o/r", pr_number: 1, expected_head_sha: "h" }),
    (err) => !String(err.message).includes(token),
  )
})

test("GitHub adapter without a token sends no Authorization header", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    return { ok: true, status: 200, json: async () => ({ state: "open", merged: false, head: { sha: "h" }, base: { sha: "b", ref: "main" } }) }
  }
  const adapter = createGitHubAdapter({ token: "", baseUrl: "https://api.example.com", fetchImpl })
  await adapter.getPullRequest({ repository: "o/r", pr_number: 1 })
  assert.equal(calls[0].headers.Authorization, undefined)
})
