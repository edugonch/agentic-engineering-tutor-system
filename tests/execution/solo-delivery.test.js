import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { candidateGitTree } from "../../src/execution/git-tree.js"
import { runMergeCandidate } from "../../src/execution/merge.js"
import { seedWuContract } from "./wu-fixture.js"
import { soloAccepted } from "../../src/execution/solo-delivery.js"

const SHA = "a".repeat(40), BASE = "b".repeat(40)
const policy = {
  execution_id: "E1", mandate_id: "E1-MANDATE-001", mode: "SOLO_CI",
  eligible_wu_ids: ["WU-01"], ci_check: "verify",
}
const check = { commands: [{ id: "jit-test", program: "npm", args: ["test"], timeout_ms: 300000 }],
  environment: { network_policy: "UNRESTRICTED" } }

async function fixture(t, { policyEnabled = true, policyContent = null, policyStatus = "APPROVED" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-solo-ci-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = (action, args = {}) => runExecutionController(root, {
    action, execution_id: "E1", session_id: "ses_root", ...args,
  })
  await recordKnowledgeArtifact(root, {
    artifact_type: "epic", artifact_id: "epic-solo", title: "Owner-approved solo Epic",
    status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.org/approved"],
    content: "execution_mandate: " + JSON.stringify({ max_wus: 1, total_seconds: 3600,
      merge_policy: "governed_auto", required_ci_checks: [],
      wu_sequence: ["WU-01"] }),
  })
  await seedWuContract(root, "WU-01", "epic-solo", 1800, check)
  await run("approve_mandate", { epic_artifact_id: "epic-solo" })
  await run("activate_wu", { wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
  await writeFile(join(root, "change.txt"), "hello")
  const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })
  const candidate = await freezeCandidate(root, { paths: ["change.txt"], verification_contract: check })
  await registry.store(candidate)
  await run("record_candidate", { candidate_id: candidate.candidate_id })
  await recordKnowledgeArtifact(root, {
    artifact_type: "decision", artifact_id: "POLICY-SOLO-E1", title: "Owner opt-in to SOLO_CI",
    status: policyStatus, owner_confirmed: true, source_refs: ["https://example.org/approved"],
    content: policyContent ?? "solo_delivery: " + JSON.stringify(policy),
  })
  if (policyEnabled) await run("adopt_solo_delivery", { decision_artifact_id: "POLICY-SOLO-E1" })
  const state = async () => (await createExecutionController({
    dir: join(root, ".harness", "execution", "controller", "E1"),
  })).snapshot().then(s => s.state)
  return { root, run, candidate, state }
}

function adapter({ ci = "SUCCESS", head = SHA, base = BASE, treeOK = true } = {}) {
  let merged = false, mergeCalls = 0, reads = 0
  return {
    getReads: () => reads, getMergeCalls: () => mergeCalls,
    getCommitTree: async () => treeOK ? candidateGitTree({ overlay: [{
      path: "change.txt", type: "file", mode: "100644",
      content: Buffer.from("hello").toString("base64"),
    }] }) : "bad-tree",
    getPullRequest: async () => ({ state: merged ? "closed" : "open", merged,
      head_sha: head, base_sha: base, base_branch: "main",
      merge_commit_sha: merged ? "merged-commit" : null }),
    getChecks: async ({check_names}) => { reads++; return check_names.map(name => ({ name, conclusion: ci })) },
    merge: async () => { mergeCalls++; merged = true; return { merged: true, merge_commit_sha: "merged-commit" } },
  }
}

async function bind(f) {
  await f.run("bind_pr", { candidate_id: f.candidate.candidate_id,
    repository: "owner/repo", pr_number: 246, head_sha: SHA, base_sha: BASE, base_branch: "main" })
}

test("SOLO_CI verifies live exact-head CI, merges, and completes low-risk WU without reviewer or local full-suite rerun", async t => {
  const f = await fixture(t)
  assert.equal((await f.state()).solo_delivery.policy.ci_check, "verify")
  await bind(f)
  const a = adapter()
  const result = await runMergeCandidate(f.root, {
    candidate_id: f.candidate.candidate_id, adapter: a, session_id: "ses_root",
  })
  assert.equal(result.status, "merged")
  assert.equal(a.getMergeCalls(), 1)
  assert.ok(a.getReads() >= 1)
  const state = await f.state()
  assert.equal(soloAccepted(state, f.candidate.candidate_id), true)
  assert.equal(state.solo_acceptances[f.candidate.candidate_id].basis, "LIVE_GITHUB_CI")
  assert.equal(state.reviews[f.candidate.candidate_id], undefined)
  assert.equal(state.merge.status, "VERIFIED")
  const close = await f.run("complete_wu", { candidate_id: f.candidate.candidate_id })
  assert.equal(close.wu.completed, true)
  const final = await f.state()
  assert.equal(final.completed_wus["WU-01"].candidate_id, f.candidate.candidate_id)
  assert.equal(final.wu.completion.acceptance_basis, "SOLO_CI")
  assert.equal((await runMergeCandidate(f.root, {
    candidate_id: f.candidate.candidate_id, adapter: a, session_id: "ses_root",
  })).status, "already_verified")
  assert.equal(a.getMergeCalls(), 1)
})

test("without adopted SOLO_CI policy, previous reviewer gate is unchanged", async t => {
  const f = await fixture(t, { policyEnabled: false })
  await bind(f)
  const a = adapter()
  await assert.rejects(runMergeCandidate(f.root, { candidate_id: f.candidate.candidate_id,
    adapter: a, session_id: "ses_root" }), /no PASS review/)
  assert.equal(a.getMergeCalls(), 0)
  await assert.rejects(f.run("complete_wu", { candidate_id: f.candidate.candidate_id }), /no review/)
})

for (const ci of ["FAILURE", "PENDING", null]) test(`SOLO_CI refuses CI ${ci} without acceptance or merge`, async t => {
  const f = await fixture(t)
  await bind(f)
  const a = adapter({ ci })
  await assert.rejects(runMergeCandidate(f.root, { candidate_id: f.candidate.candidate_id,
    adapter: a, session_id: "ses_root" }), /SOLO_CI:/)
  const state = await f.state()
  assert.equal(state.solo_acceptances, undefined)
  assert.equal(state.merge, null)
  assert.equal(a.getMergeCalls(), 0)
})

test("head mismatch fails closed before accepting or merging, even if CI returns SUCCESS", async t => {
  const f = await fixture(t)
  await bind(f)
  const a = adapter({ head: "f".repeat(40) })
  await assert.rejects(runMergeCandidate(f.root, { candidate_id: f.candidate.candidate_id,
    adapter: a, session_id: "ses_root" }), /SOLO_CI: PR head\/base changed/)
  assert.equal((await f.state()).solo_acceptances, undefined)
  assert.equal(a.getMergeCalls(), 0)
})

test("wrong candidate tree blocks CI acceptance and merge", async t => {
  const f = await fixture(t)
  await bind(f)
  const a = adapter({ treeOK: false })
  await assert.rejects(runMergeCandidate(f.root, { candidate_id: f.candidate.candidate_id,
    adapter: a, session_id: "ses_root" }), /tree|candidate/i)
  assert.equal((await f.state()).solo_acceptances, undefined)
  assert.equal(a.getMergeCalls(), 0)
})

test("owner policy must be locally indexed, APPROVED and exact; no flag-only bypass", async t => {
  const f = await fixture(t, { policyEnabled: false, policyStatus: "PROPOSED" })
  await assert.rejects(f.run("adopt_solo_delivery", { decision_artifact_id: "POLICY-SOLO-E1" }), /APPROVED|owner/i)
  await assert.rejects(f.run("adopt_solo_delivery", { decision_artifact_id: "none" }), /APPROVED|owner/i)
  assert.equal((await f.state()).solo_delivery, undefined)
})

test("malformed and duplicated policy keys never authorize solo acceptance", async t => {
  const raw = 'solo_delivery: {"execution_id":"E1","mandate_id":"E1-MANDATE-001","mode":"SOLO_CI","eligible_wu_ids":["WU-01"],"ci_check":"verify","ci_check":"none"}'
  const f = await fixture(t, { policyEnabled: false, policyContent: raw })
  await assert.rejects(f.run("adopt_solo_delivery", { decision_artifact_id: "POLICY-SOLO-E1" }), /SOLO_CI_AUTHORITY_UNMAPPED/)
  assert.equal((await f.state()).solo_delivery, undefined)
})

test("solo policy cannot be used for an active batch, critical/unlisted WUs, or a process blocker", async t => {
  const f = await fixture(t)
  await bind(f)
  // No model override can turn another WU into an owner-approved one.
  const original = await f.state()
  assert.equal(soloAccepted({ ...original, wu: { wu_id: "OTHER" } }, f.candidate.candidate_id), false)
  assert.equal(soloAccepted({ ...original, wu: { ...original.wu, batch: { wu_ids: ["WU-01","WU-02"] } } }, f.candidate.candidate_id), false)
  await f.run("block", { class: "BLOCKED_TOOLING", reason: "unresolved test environment" })
  const a = adapter()
  await assert.rejects(runMergeCandidate(f.root, { candidate_id: f.candidate.candidate_id,
    adapter: a, session_id: "ses_root" }), /blocker/)
  assert.equal(a.getMergeCalls(), 0)
})
