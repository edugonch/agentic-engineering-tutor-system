// Regression: a new WU/candidate must never be blocked (or mis-closed) by a
// completed predecessor's settled merge.
//
// Observed defect (ALFRAN WU072 / PR #178): after a verification-contract
// correction invalidated the current PR binding (`pr_binding = null`), the next
// BIND_PR bound the new candidate but left the completed predecessor's VERIFIED
// merge in `state.merge`. harness_merge_candidate / harness_verify_external_merge
// then rejected the correct candidate with "merge belongs to a different candidate".
//
// The fix is an append-only, governed reconciliation event: MERGE_SUPERSEDE
// retires only a settled VERIFIED merge of a completed predecessor for the
// candidate currently bound. The projection of every existing event is left
// untouched, so historical logs (and their committed executionProgress hashes)
// replay byte-identically. These tests are RED on the unfixed core.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initialState, applyEvent, project } from "../../src/execution/state.js"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { candidateGitTree } from "../../src/execution/git-tree.js"
import { runCandidateVerification } from "../../src/execution/verification.js"
import { createVerificationReceipt, writeVerificationReceipt } from "../../src/execution/verification-results.js"
import { runMergeCandidate, runVerifyExternalMerge } from "../../src/execution/merge.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { seedWuContract } from "./wu-fixture.js"

const VERIFY_CONTRACT = {
  commands: [{ id: "verify", program: "node", args: ["-e", "process.exit(0)"] }],
  environment: { network_policy: "UNRESTRICTED" },
}

// ---------------------------------------------------------------------------
// Pure projection: the reconciliation event and its refusals.
// ---------------------------------------------------------------------------

function staleState(overrides = {}) {
  return {
    ...initialState(),
    mandate: { mandate_id: "M", merge_policy: "governed_auto", required_ci_checks: ["verify"], max_wus: 2 },
    wu: { wu_id: "WU-2", completed: false },
    candidates: { c1: { wu_id: "WU-1" }, c2: { wu_id: "WU-2" } },
    completed_wus: { "WU-1": { candidate_id: "c1" } },
    merges: { c1: { status: "VERIFIED", candidate_id: "c1" } },
    pr_binding: { candidate_id: "c2", repository: "o/r", pr_number: 2, head_sha: "h2" },
    merge: { status: "VERIFIED", candidate_id: "c1", merged_head_sha: "h1", expected_head_sha: "h1", merge_commit_sha: "merge1" },
    ...overrides,
  }
}

test("MERGE_SUPERSEDE retires a settled predecessor merge for the currently bound candidate", () => {
  const next = applyEvent(staleState(), {
    operation_type: "MERGE_SUPERSEDE",
    body: { superseded_candidate_id: "c1", bound_candidate_id: "c2", merge_commit_sha: "merge1" },
  })
  assert.equal(next.merge, null)
  assert.equal(next.pr_binding.candidate_id, "c2")
  assert.equal(next.merges.c1.status, "VERIFIED") // durable history preserved
  assert.equal(next.merge_history.at(-1).status, "SUPERSEDED")
  assert.equal(next.merge_history.at(-1).superseded_by_candidate_id, "c2")
})

test("MERGE_SUPERSEDE refuses anything that is not a settled completed-predecessor merge", () => {
  const apply = (state, body) => applyEvent(state, { operation_type: "MERGE_SUPERSEDE", body })
  const body = { superseded_candidate_id: "c1", bound_candidate_id: "c2", merge_commit_sha: "merge1" }
  assert.throws(() => apply(staleState({ merge: null }), body), /requires an existing merge pointer/)
  assert.throws(() => apply(staleState({ merge: { status: "STARTED", candidate_id: "c1" } }), body), /not settled/)
  assert.throws(() => apply(staleState({ merge: { status: "RECORDED", candidate_id: "c1" } }), body), /not settled/)
  assert.throws(() => apply(staleState({ pr_binding: null }), body), /current PR binding/)
  assert.throws(() => apply(staleState({ merge: { status: "VERIFIED", candidate_id: "c2" } }), body), /already belongs to the bound candidate/)
  assert.throws(() => apply(staleState({ completed_wus: {} }), body), /completed predecessor/)
  assert.throws(() => apply(staleState({ completed_wus: { "WU-1": { candidate_id: "other" } } }), body), /completed predecessor/)
  // predecessor merge that belongs to the ACTIVE WU is not a completed predecessor
  assert.throws(() => apply(staleState({ candidates: { c1: { wu_id: "WU-2" }, c2: { wu_id: "WU-2" } } }), body), /completed predecessor/)
  assert.throws(() => apply(staleState(), { superseded_candidate_id: "c2", bound_candidate_id: "c1" }), /does not match/)
  // the durable audit body is bound to the exact recorded merge commit
  assert.throws(() => apply(staleState(), { superseded_candidate_id: "c1", bound_candidate_id: "c2", merge_commit_sha: "wrong" }), /does not match/)
})

test("MERGE_SUPERSEDE is reconciliation, not forward execution: allowed under a terminal blocker", () => {
  const blocked = staleState({ blocker: { class: "BLOCKED_SECURITY", reason: "hard stop", at_revision: 0 } })
  const next = applyEvent(blocked, { operation_type: "MERGE_SUPERSEDE", body: { superseded_candidate_id: "c1", bound_candidate_id: "c2", merge_commit_sha: "merge1" } })
  assert.equal(next.merge, null)
  assert.equal(next.blocker.class, "BLOCKED_SECURITY") // the hard stop itself is preserved
  // ...while actually starting a merge remains forward execution and stays blocked.
  assert.throws(() => applyEvent(blocked, { operation_type: "MERGE_START", body: {} }), /Forward execution is blocked/)
})

// ---------------------------------------------------------------------------
// End-to-end: reproduce the ALFRAN WU071 -> WU072 sequence at the controller.
// ---------------------------------------------------------------------------

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-bind-invalidation-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

async function snapshot(root) {
  const controller = await createExecutionController({ dir: join(root, ".harness", "execution", "controller", "E") })
  return controller.snapshot()
}

async function freezeReviewBind(root, run, registry, { pr_number, head_sha, base_sha = "b1" }) {
  const { state } = await snapshot(root)
  const frozen = await freezeCandidate(root, { base: { kind: "snapshot", files: [] }, verification_contract: state.wu.contract.verification_contract })
  await registry.store(frozen)
  await run("record_candidate", { candidate_id: frozen.candidate_id })
  const result = await runCandidateVerification(frozen, "verify")
  assert.equal(result.status, "PASS")
  const receipt = createVerificationReceipt(result)
  await writeVerificationReceipt(join(root, ".harness", "execution", "verification-results"), receipt)
  await run("record_review", { candidate_id: frozen.candidate_id, verdict: "PASS", reviewer: "independent-reviewer", verification_evidence_ids: [receipt.evidence_id] })
  await run("bind_pr", { candidate_id: frozen.candidate_id, repository: "o/r", pr_number, head_sha, base_sha, base_branch: "main" })
  await run("record_ci", { candidate_id: frozen.candidate_id, head_sha, check_identity: "verify", conclusion: "SUCCESS" })
  return frozen
}

// Drive a predecessor WU to a completed VERIFIED merge, then activate WU-02 and
// invalidate the inherited binding with a verification-contract correction.
async function setupPredecessorThenCorrection(root, run, registry) {
  await recordKnowledgeArtifact(root, {
    artifact_type: "epic", artifact_id: "epic-001", title: "Epic", status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.com/approval"],
    content: 'execution_mandate: {"max_wus":2,"total_seconds":400,"merge_policy":"governed_auto","required_ci_checks":["verify"]}',
  })
  await seedWuContract(root, "WU-01", "epic-001", 200, VERIFY_CONTRACT)
  await seedWuContract(root, "WU-02", "epic-001", 200, VERIFY_CONTRACT)
  await run("approve_mandate", { epic_artifact_id: "epic-001" })

  await run("activate_wu", { wu_id: "WU-01", mandate_id: "E-MANDATE-001" })
  const c1 = await freezeReviewBind(root, run, registry, { pr_number: 171, head_sha: "h1" })
  let merged1 = false
  assert.equal((await runMergeCandidate(root, { candidate_id: c1.candidate_id, session_id: "root", adapter: {
    getCommitTree: async () => candidateGitTree(c1),
    getPullRequest: async () => ({ state: merged1 ? "closed" : "open", merged: merged1, head_sha: "h1", base_sha: "b1", base_branch: "main", merge_commit_sha: merged1 ? "merge1" : null }),
    getChecks: async () => [{ name: "verify", conclusion: "SUCCESS" }],
    merge: async () => { merged1 = true; return { merged: true, merge_commit_sha: "merge1" } },
  } })).status, "merged")
  await run("complete_wu", { candidate_id: c1.candidate_id })

  await run("activate_wu", { wu_id: "WU-02", mandate_id: "E-MANDATE-001" })
  const old = (await snapshot(root)).state.wu.contract
  const typed = { active_seconds: old.active_seconds, process_obligations: old.process_obligations,
    verification_contract: { ...old.verification_contract, commands: [{ id: "verify", program: "node", args: ["-e", "process.exit(0)", "// corrected"] }] } }
  const content = "# Verification correction\n" + old.source_content.replace(/^execution_contract: .*$/m, "execution_contract: " + JSON.stringify(typed))
  await recordKnowledgeArtifact(root, { artifact_type: "work-unit", artifact_id: "WU-02-CORRECTED", title: "Corrected WU-02", status: "APPROVED", owner_confirmed: true, parent_refs: ["epic-001"], content })
  await run("correct_verification_contract", { wu_artifact_id: "WU-02-CORRECTED", expected_contract_hash: old.contract_hash, reason: "Correct WU-02 verification command" })
  return { c1 }
}

test("a candidate bound after a contract correction reconciles an already-merged PR through MERGE_SUPERSEDE", async () => {
  await withRoot(async (root) => {
    const run = (action, extra = {}) => runExecutionController(root, { action, execution_id: "E", session_id: "root", ...extra })
    const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })
    const { c1 } = await setupPredecessorThenCorrection(root, run, registry)

    const c2 = await freezeReviewBind(root, run, registry, { pr_number: 178, head_sha: "h2" })
    const bound = (await snapshot(root)).state
    assert.equal(bound.pr_binding.candidate_id, c2.candidate_id)
    assert.equal(bound.pr_binding.pr_number, 178)
    // The projection of the historical BIND_PR is deliberately unchanged: only a
    // new, explicit reconciliation event retires the stale pointer.
    assert.equal(bound.merge.candidate_id, c1.candidate_id)

    const adapter = {
      getCommitTree: async () => candidateGitTree(c2),
      getPullRequest: async () => ({ state: "closed", merged: true, head_sha: "h2", base_sha: "b1", base_branch: "main", merge_commit_sha: "merge2" }),
      getChecks: async () => [{ name: "verify", conclusion: "SUCCESS" }],
      merge: async () => { throw new Error("governed_auto recovery must never call merge() for an already-merged PR") },
    }
    const reconciled = await runMergeCandidate(root, { candidate_id: c2.candidate_id, adapter, session_id: "root" })
    assert.equal(reconciled.status, "recovered_existing_merge")
    assert.equal(reconciled.merge_commit_sha, "merge2")
    assert.equal(reconciled.superseded_stale_merge, true)

    const mergedState = (await snapshot(root)).state
    assert.equal(mergedState.merge.status, "VERIFIED")
    assert.equal(mergedState.merge.candidate_id, c2.candidate_id)
    assert.equal(mergedState.merges[c1.candidate_id].status, "VERIFIED") // predecessor history intact
    assert.equal(mergedState.pr_bindings[c2.candidate_id].pr_number, 178)
    assert.equal(mergedState.merge_history.at(-1).status, "SUPERSEDED")

    // idempotent retry: no duplicate merge/supersede events, no second effect
    assert.equal((await runMergeCandidate(root, { candidate_id: c2.candidate_id, adapter, session_id: "root" })).status, "already_verified")
    const parsed = (await readFile(join(root, ".harness", "execution", "controller", "E", "events.ndjson"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(new Set(parsed.map((e) => e.operation_id)).size, parsed.length, "operation ids must stay unique")
    assert.equal(parsed.filter((e) => e.operation_type === "MERGE_SUPERSEDE").length, 1)
    assert.equal(parsed.filter((e) => e.operation_type === "MERGE_START").length, 2)
    assert.equal(parsed.filter((e) => e.operation_type === "MERGE_RECORD" && e.body.merge_commit_sha === "merge2").length, 1)
    assert.equal(parsed.filter((e) => e.operation_type === "MERGE_VERIFY").length, 2)

    // governed closure
    await run("complete_wu", { candidate_id: c2.candidate_id })
    assert.equal((await snapshot(root)).state.wu.completed, true)
    await run("complete")
    assert.equal((await snapshot(root)).state.completed, true)
    assert.equal((await run("verify")).passed, true)
  })
})

test("human policy also reconciles a stale predecessor merge through MERGE_SUPERSEDE", async () => {
  await withRoot(async (root) => {
    const run = (action, extra = {}) => runExecutionController(root, { action, execution_id: "E", session_id: "root", ...extra })
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: "epic-001", title: "Epic", status: "APPROVED", owner_confirmed: true,
      source_refs: ["https://example.com/approval"],
      content: 'execution_mandate: {"max_wus":2,"total_seconds":400,"merge_policy":"human","required_ci_checks":["verify"]}',
    })
    await seedWuContract(root, "WU-01", "epic-001", 200, VERIFY_CONTRACT)
    await seedWuContract(root, "WU-02", "epic-001", 200, VERIFY_CONTRACT)
    await run("approve_mandate", { epic_artifact_id: "epic-001" })
    const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })

    await run("activate_wu", { wu_id: "WU-01", mandate_id: "E-MANDATE-001" })
    const c1 = await freezeReviewBind(root, run, registry, { pr_number: 171, head_sha: "h1" })
    const humanAdapter = (merged, head_sha, sha, candidate) => ({
      getCommitTree: async () => candidateGitTree(candidate),
      getPullRequest: async () => ({ state: merged ? "closed" : "open", merged, head_sha, base_sha: "b1", base_branch: "main", merge_commit_sha: merged ? sha : null }),
      getChecks: async () => [{ name: "verify", conclusion: "SUCCESS" }],
    })
    assert.equal((await runVerifyExternalMerge(root, { candidate_id: c1.candidate_id, adapter: humanAdapter(true, "h1", "merge1", c1), session_id: "root" })).status, "verified_external_merge")
    await run("complete_wu", { candidate_id: c1.candidate_id })

    await run("activate_wu", { wu_id: "WU-02", mandate_id: "E-MANDATE-001" })
    const old = (await snapshot(root)).state.wu.contract
    const typed = { active_seconds: old.active_seconds, process_obligations: old.process_obligations,
      verification_contract: { ...old.verification_contract, commands: [{ id: "verify", program: "node", args: ["-e", "process.exit(0)", "// corrected"] }] } }
    const content = "# Verification correction\n" + old.source_content.replace(/^execution_contract: .*$/m, "execution_contract: " + JSON.stringify(typed))
    await recordKnowledgeArtifact(root, { artifact_type: "work-unit", artifact_id: "WU-02-CORRECTED", title: "Corrected WU-02", status: "APPROVED", owner_confirmed: true, parent_refs: ["epic-001"], content })
    await run("correct_verification_contract", { wu_artifact_id: "WU-02-CORRECTED", expected_contract_hash: old.contract_hash, reason: "Correct WU-02 verification command" })

    const c2 = await freezeReviewBind(root, run, registry, { pr_number: 178, head_sha: "h2" })
    const reconciled = await runVerifyExternalMerge(root, { candidate_id: c2.candidate_id, adapter: humanAdapter(true, "h2", "merge2", c2), session_id: "root" })
    assert.equal(reconciled.status, "verified_external_merge")
    assert.equal(reconciled.superseded_stale_merge, true)
    await run("complete_wu", { candidate_id: c2.candidate_id })
    assert.equal((await snapshot(root)).state.wu.completed, true)
  })
})

test("reconciliation rejects a PR whose head drifted from the bound candidate", async () => {
  await withRoot(async (root) => {
    const run = (action, extra = {}) => runExecutionController(root, { action, execution_id: "E", session_id: "root", ...extra })
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: "epic-001", title: "Epic", status: "APPROVED", owner_confirmed: true,
      source_refs: ["https://example.com/approval"],
      content: 'execution_mandate: {"max_wus":1,"total_seconds":200,"merge_policy":"governed_auto","required_ci_checks":["verify"]}',
    })
    await seedWuContract(root, "WU-01", "epic-001", 200, VERIFY_CONTRACT)
    await run("approve_mandate", { epic_artifact_id: "epic-001" })
    await run("activate_wu", { wu_id: "WU-01", mandate_id: "E-MANDATE-001" })
    const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })
    const c = await freezeReviewBind(root, run, registry, { pr_number: 190, head_sha: "h-bound" })
    await assert.rejects(
      runMergeCandidate(root, { candidate_id: c.candidate_id, session_id: "root", adapter: {
        getCommitTree: async () => candidateGitTree(c),
        getPullRequest: async () => ({ state: "closed", merged: true, head_sha: "h-drifted", base_sha: "b1", base_branch: "main", merge_commit_sha: "merge" }),
        getChecks: async () => [{ name: "verify", conclusion: "SUCCESS" }],
        merge: async () => ({ merged: true, merge_commit_sha: "merge" }),
      } }),
      /drifted from bound/,
    )
    const state = (await snapshot(root)).state
    assert.equal(state.merge, null, "a rejected reconciliation must not record a merge")
    assert.equal(state.merge_history ?? null, null, "a rejected reconciliation must not fabricate a supersede")
  })
})

test("historical replay of the corrected-binding sequence stays invariant and append-only", async () => {
  await withRoot(async (root) => {
    const run = (action, extra = {}) => runExecutionController(root, { action, execution_id: "E", session_id: "root", ...extra })
    const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })
    const { c1 } = await setupPredecessorThenCorrection(root, run, registry)
    const c2 = await freezeReviewBind(root, run, registry, { pr_number: 178, head_sha: "h2" })
    await runMergeCandidate(root, { candidate_id: c2.candidate_id, session_id: "root", adapter: {
      getCommitTree: async () => candidateGitTree(c2),
      getPullRequest: async () => ({ state: "closed", merged: true, head_sha: "h2", base_sha: "b1", base_branch: "main", merge_commit_sha: "merge2" }),
      getChecks: async () => [{ name: "verify", conclusion: "SUCCESS" }],
      merge: async () => { throw new Error("must not merge") },
    } })

    const logPath = join(root, ".harness", "execution", "controller", "E", "events.ndjson")
    const before = await readFile(logPath, "utf8")
    const rebuilt = project(before.split("\n").filter(Boolean).map((line) => JSON.parse(line)))
    const live = (await snapshot(root)).state
    assert.deepEqual(rebuilt, live) // the controller's projection is exactly the replay
    assert.equal(rebuilt.merge.candidate_id, c2.candidate_id)
    assert.equal(rebuilt.merges[c1.candidate_id].status, "VERIFIED") // completed predecessor preserved
    assert.equal(rebuilt.merge_history.at(-1).status, "SUPERSEDED")
    assert.equal(rebuilt.pr_binding.candidate_id, c2.candidate_id)
    assert.equal(await readFile(logPath, "utf8"), before) // append-only: no rewrite on replay
  })
})
