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
import { createVerificationReceipt, writeVerificationReceipt } from "../../src/execution/verification-results.js"
import { seedWuContract } from "./wu-fixture.js"
import { soloAccepted } from "../../src/execution/solo-delivery.js"
import { initialState, applyEvent } from "../../src/execution/state.js"
import { stableHash } from "../../src/execution/serialize.js"

const SHA = "a".repeat(40), BASE = "b".repeat(40)
const policy = { execution_id: "E1", mandate_id: "E1-MANDATE-001",
  mode: "SOLO_LOCAL", checks_by_wu: { "WU-01": ["focused-test"] } }
const contract = { commands: [
  { id: "focused-test", program: "node", args: ["-e", "process.exit(0)"] },
  { id: "slow-full-test", program: "npm", args: ["test"], timeout_ms: 300000 },
], environment: { network_policy: "UNRESTRICTED" } }

async function fixture(t, {
  policyEnabled = true, policyStatus = "APPROVED", policyContent = null,
  receiptStatus = "PASS", receiptCandidate = null, receiptContract = null,
  requiredCiChecks = ["legacy-check"],
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-solo-local-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = (action, args = {}) => runExecutionController(root, {
    action, execution_id: "E1", session_id: "ses_root", ...args,
  })
  await recordKnowledgeArtifact(root, {
    artifact_type: "epic", artifact_id: "epic-solo", title: "Approved Solo Epic",
    status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.org/owner"],
    content: "execution_mandate: " + JSON.stringify({ max_wus: 1,
      total_seconds: 3600, merge_policy: "governed_auto",
      required_ci_checks: requiredCiChecks, wu_sequence: ["WU-01"] }),
  })
  await seedWuContract(root, "WU-01", "epic-solo", 1800, contract)
  await run("approve_mandate", { epic_artifact_id: "epic-solo" })
  await run("activate_wu", { wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
  await writeFile(join(root, "change.txt"), "hello")
  const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })
  const candidate = await freezeCandidate(root, { paths: ["change.txt"], verification_contract: contract })
  await registry.store(candidate)
  await run("record_candidate", { candidate_id: candidate.candidate_id })
  if (receiptStatus !== null) {
    await writeVerificationReceipt(join(root, ".harness/execution/verification-results"),
      createVerificationReceipt({
        candidate_id: receiptCandidate ?? candidate.candidate_id,
        verification_contract_hash: receiptContract ?? candidate.manifest.verification_contract.contract_hash,
        check_id: "focused-test", status: receiptStatus,
        exitCode: receiptStatus === "PASS" ? 0 : 1,
        fingerprint: { node: "test", timestamp: "2026-11-08T12:00:00.000Z" },
        stdout: receiptStatus === "PASS" ? "11/11 tests pass" : "failed",
      }))
  }
  await recordKnowledgeArtifact(root, {
    artifact_type: "decision", artifact_id: "POLICY-SOLO-E1", title: "Owner solo local delivery",
    status: policyStatus, owner_confirmed: true, source_refs: ["https://example.org/owner"],
    content: policyContent ?? "solo_delivery: " + JSON.stringify(policy),
  })
  if (policyEnabled) await run("adopt_solo_delivery", { decision_artifact_id: "POLICY-SOLO-E1" })
  const state = async () => {
    const c = await createExecutionController({ dir: join(root, ".harness/execution/controller/E1") })
    return (await c.snapshot()).state
  }
  return { root, run, candidate, state }
}

function adapter({ head = SHA, base = BASE, treeOK = true } = {}) {
  let merged = false, calls = 0
  return {
    mergeCalls: () => calls,
    getCommitTree: async () => treeOK ? candidateGitTree({ overlay: [{
      path: "change.txt", type: "file", mode: "100644",
      content: Buffer.from("hello").toString("base64"),
    }] }) : "bad-tree",
    getPullRequest: async () => ({ state: merged ? "closed" : "open", merged,
      head_sha: head, base_sha: base, base_branch: "main",
      merge_commit_sha: merged ? "merge-ok" : null }),
    // This must NEVER be queried, including under historical mandates
    // declaring required_ci_checks. Live GitHub CI is not authority.
    getChecks: async () => assert.fail("deprecated GitHub CI must never be queried"),
    merge: async () => { calls++; merged = true
      return { merged: true, merge_commit_sha: "merge-ok" } },
  }
}
async function bind(f) {
  await f.run("bind_pr", { candidate_id: f.candidate.candidate_id,
    repository: "owner/repo", pr_number: 246, head_sha: SHA,
    base_sha: BASE, base_branch: "main" })
}
async function merge(f, a = adapter()) {
  return runMergeCandidate(f.root, {
    candidate_id: f.candidate.candidate_id, adapter: a, session_id: "ses_root",
  })
}

test("owner-selected focused local check closes WU, even with old mandatory CI and timed-out slow full test", async t => {
  const f = await fixture(t)
  await bind(f)
  const a = adapter()
  assert.equal((await merge(f,a)).status, "merged")
  assert.equal(a.mergeCalls(), 1)
  const state = await f.state()
  assert.equal(soloAccepted(state, f.candidate.candidate_id), true)
  assert.equal(state.reviews[f.candidate.candidate_id], undefined)
  assert.equal(state.solo_acceptances[f.candidate.candidate_id].basis, "LOCAL_VERIFICATION")
  assert.deepEqual(state.solo_acceptances[f.candidate.candidate_id].verified_check_ids, ["focused-test"])
  assert.equal(state.merge.status, "VERIFIED")
  const closed = await f.run("complete_wu", { candidate_id: f.candidate.candidate_id })
  assert.equal(closed.wu.completed, true)
  assert.equal((await f.state()).wu.completion.acceptance_basis, "LOCAL_VERIFICATION")
  assert.equal((await merge(f,a)).status, "already_verified")
  assert.equal(a.mergeCalls(), 1)
})

test("no adopted SOLO_LOCAL policy preserves the independent-review gate", async t => {
  const f = await fixture(t, { policyEnabled: false })
  await bind(f)
  const a = adapter()
  await assert.rejects(merge(f,a), /no PASS review/)
  assert.equal(a.mergeCalls(), 0)
  await assert.rejects(f.run("complete_wu", { candidate_id: f.candidate.candidate_id }), /no review/)
})

for (const [name, changes] of [
  ["missing", { receiptStatus: null }],
  ["failed", { receiptStatus: "FAIL" }],
  ["other candidate", { receiptCandidate: "cand-other" }],
  ["stale contract", { receiptContract: "f".repeat(64) }],
]) test("SOLO_LOCAL refuses " + name + " receipts and does not merge", async t => {
  const f = await fixture(t, changes)
  await bind(f)
  const a = adapter()
  await assert.rejects(merge(f,a), /SOLO_LOCAL: missing (PASS receipt|local verification receipts)/)
  assert.equal((await f.state()).solo_acceptances, undefined)
  assert.equal(a.mergeCalls(), 0)
})

test("remote PR head/base drift or candidate tree mismatch still fails closed", async t => {
  const f = await fixture(t)
  await bind(f)
  for (const a of [adapter({ head: "f".repeat(40) }),
    adapter({ base: "f".repeat(40) }), adapter({ treeOK: false })]) {
    await assert.rejects(merge(f,a), /SOLO_LOCAL: PR head\/base changed|candidate Git tree/)
    assert.equal(a.mergeCalls(), 0)
  }
  assert.equal((await f.state()).solo_acceptances, undefined)
})

test("unapproved, duplicate-field or obsolete CI-only owner decision cannot activate solo delivery", async t => {
  for (const [name, options] of [
    ["DRAFT", { policyStatus: "PROPOSED" }],
    ["DUPLICATE", { policyContent: 'solo_delivery: {"execution_id":"E1","mandate_id":"E1-MANDATE-001","mode":"SOLO_LOCAL","checks_by_wu":{"WU-01":["focused-test"]},"mode":"SOLO_LOCAL"}' }],
    ["OBSOLETE", { policyContent: 'solo_delivery: {"execution_id":"E1","mandate_id":"E1-MANDATE-001","mode":"SOLO_CI","eligible_wu_ids":["WU-01"],"ci_check":"verify"}' }],
  ]) {
    const f = await fixture(t, { ...options, policyEnabled: false })
    await assert.rejects(f.run("adopt_solo_delivery", { decision_artifact_id: "POLICY-SOLO-E1" }))
    assert.equal((await f.state()).solo_delivery, undefined, name)
  }
})

test("unlisted, batched, blocked or independently rejected work cannot use the local shortcut", async t => {
  const f = await fixture(t)
  await bind(f)
  const s = await f.state()
  assert.equal(soloAccepted({ ...s, wu: { wu_id: "other" } }, f.candidate.candidate_id), false)
  assert.equal(soloAccepted({ ...s, wu: { ...s.wu, batch: { wu_ids: ["WU-01", "WU-02"] } } },
    f.candidate.candidate_id), false)
  await f.run("block", { class: "BLOCKED_TOOLING", reason: "unresolved runtime" })
  await assert.rejects(merge(f), /blocker/)
})


test("historical SOLO_CI receipts replay but cannot be emitted or authorize fresh work", () => {
  const state = initialState()
  state.execution_id = "E1:exec"
  state.mandate = { mandate_id: "E1-MANDATE-001",
    authority_kind: "OWNER_APPROVED_EPIC", merge_policy: "governed_auto",
    required_ci_checks: ["obsolete"] }
  state.wu = { wu_id: "WU-01", completed: false }
  state.candidates["cand-legacy"] = { wu_id: "WU-01",
    tree_hash: "t", manifest_hash: "m" }
  state.pr_binding = { candidate_id: "cand-legacy", head_sha: SHA }
  state.solo_delivery = { policy: {
    execution_id: "E1", mandate_id: "E1-MANDATE-001", mode: "SOLO_CI",
    eligible_wu_ids: ["WU-01"], ci_check: "verify",
  }, source_hash: "f".repeat(64) }
  const body = { candidate_id: "cand-legacy", head_sha: SHA,
    candidate_hashes: { manifest_hash: "m", tree_hash: "t" },
    source_hash: "f".repeat(64), basis: "LIVE_GITHUB_CI",
    ci_check: "verify", conclusion: "SUCCESS", evidence_ref: "old-run" }
  const event = { operation_type: "SOLO_CI_ACCEPT", operation_id: "legacy",
    sequence: 1, previous_revision: 0, next_revision: 1,
    fencing_token: 1, timestamp: "2026-11-01T00:00:00.000Z",
    operation_hash: stableHash(body), body }
  const replay = applyEvent(state, event, { historicalReplay: true })
  assert.equal(soloAccepted(replay, "cand-legacy", { historicalReplay: true }), true)
  assert.equal(soloAccepted(replay, "cand-legacy"), false)
  assert.throws(() => applyEvent(state, event), /SOLO_CI_DEPRECATED/)
})
