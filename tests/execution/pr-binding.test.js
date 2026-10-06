import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyEvent, project } from "../../src/execution/state.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { stableHash } from "../../src/execution/serialize.js"

// --- state-machine helpers ---
function makeBuilder() {
  let seq = 0
  return (operation_type, body) => {
    seq += 1
    return {
      sequence: seq,
      event_id: `e${seq}`,
      operation_id: `op-${seq}`,
      operation_type,
      operation_hash: stableHash(body),
      body,
      previous_revision: seq - 1,
      next_revision: seq,
      fencing_token: 1,
      timestamp: "t",
    }
  }
}

function nextEvent(state, operation_type, body) {
  const seq = state.revision + 1
  return {
    sequence: seq,
    event_id: `e${seq}`,
    operation_id: "op-next",
    operation_type,
    operation_hash: stableHash(body),
    body,
    previous_revision: state.revision,
    next_revision: seq,
    fencing_token: 1,
    timestamp: "t",
  }
}

const MANDATE = { mandate_id: "M1", max_wus: 4, total_seconds: 100 }
const CANDIDATE = { candidate_id: "cand-1", manifest_hash: "m1", tree_hash: "t1" }

// mandate + freeze a candidate (no active WU: BIND_PR/RECORD_CI don't require one)
function base(ev) {
  return [ev("MANDATE_APPROVE", MANDATE), ev("FREEZE_CANDIDATE", CANDIDATE)]
}

// --- BIND_PR ---
test("BIND_PR persists an immutable binding (repository, pr, candidate, head/base)", () => {
  const ev = makeBuilder()
  const events = [...base(ev), ev("BIND_PR", { repository: "owner/repo", pr_number: 158, candidate_id: "cand-1", head_sha: "head-a", base_branch: "main", base_sha: "base-1" })]
  const s = project(events)
  assert.equal(s.pr_binding.repository, "owner/repo")
  assert.equal(s.pr_binding.pr_number, 158)
  assert.equal(s.pr_binding.head_sha, "head-a")
  assert.equal(s.pr_binding.base_sha, "base-1")
})

test("BIND_PR rejects a different binding (immutable; head change needs a new candidate)", () => {
  const ev = makeBuilder()
  const events = [...base(ev), ev("BIND_PR", { repository: "owner/repo", pr_number: 158, candidate_id: "cand-1", head_sha: "head-a", base_branch: "main", base_sha: "base-1" })]
  const s = project(events)
  assert.throws(
    () => applyEvent(s, nextEvent(s, "BIND_PR", { repository: "owner/repo", pr_number: 158, candidate_id: "cand-1", head_sha: "head-b", base_branch: "main", base_sha: "base-1" })),
    /already bound/,
  )
  // original binding intact
  assert.equal(s.pr_binding.head_sha, "head-a")
})

test("BIND_PR rejects an unknown candidate and a missing base_sha", () => {
  const ev = makeBuilder()
  const s = project(base(ev))
  assert.throws(
    () => applyEvent(s, nextEvent(s, "BIND_PR", { repository: "o/r", pr_number: 1, candidate_id: "cand-unknown", head_sha: "h", base_branch: "main", base_sha: "b" })),
    /unknown candidate/,
  )
  assert.throws(
    () => applyEvent(s, nextEvent(s, "BIND_PR", { repository: "o/r", pr_number: 1, candidate_id: "cand-1", head_sha: "h", base_branch: "main" })),
    /requires base_sha/,
  )
})

// --- RECORD_CI ---
test("RECORD_CI records multiple checks per candidate without overwriting", () => {
  const ev = makeBuilder()
  const events = [
    ...base(ev),
    ev("RECORD_CI", { candidate_id: "cand-1", head_sha: "head-a", check_identity: "check-1", conclusion: "SUCCESS" }),
    ev("RECORD_CI", { candidate_id: "cand-1", head_sha: "head-a", check_identity: "check-2", conclusion: "SUCCESS" }),
  ]
  const s = project(events)
  assert.equal(s.ci_evidence["cand-1"]["check-1"].conclusion, "SUCCESS")
  assert.equal(s.ci_evidence["cand-1"]["check-2"].conclusion, "SUCCESS")
  assert.equal(Object.keys(s.ci_evidence["cand-1"]).length, 2) // both kept, no overwrite
})

test("RECORD_CI rejects an unknown candidate and an invalid conclusion", () => {
  const ev = makeBuilder()
  const s = project(base(ev))
  assert.throws(
    () => applyEvent(s, nextEvent(s, "RECORD_CI", { candidate_id: "cand-unknown", head_sha: "h", check_identity: "check-1", conclusion: "SUCCESS" })),
    /unknown candidate/,
  )
  assert.throws(
    () => applyEvent(s, nextEvent(s, "RECORD_CI", { candidate_id: "cand-1", head_sha: "h", check_identity: "check-1", conclusion: "GARBAGE" })),
    /invalid conclusion/,
  )
})

// --- controller-level (bind_pr / record_ci actions) ---
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-pr-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

async function governedCandidate(root, sid) {
  await recordKnowledgeArtifact(root, {
    artifact_type: "epic", artifact_id: "epic-001", status: "APPROVED", owner_confirmed: true,
    title: "Test Epic", content: 'test epic\nexecution_mandate: {"max_wus": 4, "total_seconds": 100}',
    source_refs: ["https://example.com/epic-source"],
  })
  await runExecutionController(root, { action: "approve_mandate", execution_id: "E1", session_id: sid, epic_artifact_id: "epic-001" })
  await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
  await writeFile(join(root, "change.txt"), "hello")
  const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })
  const candidate = await freezeCandidate(root, { paths: ["change.txt"], verification_contract: { commands: [{ id: "check-1", program: "node", args: ["-e", "process.exit(0)"] }], environment: { network_policy: "UNRESTRICTED" }, source_wu_id: "WU-01" } })
  await registry.store(candidate)
  await runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id })
  return candidate
}

test("controller bind_pr → record_ci persists binding and CI evidence", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    const candidate = await governedCandidate(root, sid)
    const bound = await runExecutionController(root, { action: "bind_pr", execution_id: "E1", session_id: sid, repository: "owner/repo", pr_number: 158, candidate_id: candidate.candidate_id, head_sha: "head-a", base_branch: "main", base_sha: "base-1" })
    assert.equal(bound.commit_status, "committed")
    assert.equal(bound.pr_binding.head_sha, "head-a")

    const ci = await runExecutionController(root, { action: "record_ci", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id, head_sha: "head-a", check_identity: "check-1", conclusion: "SUCCESS", evidence_ref: "run-1" })
    assert.equal(ci.commit_status, "committed")
    assert.equal(ci.ci_evidence[candidate.candidate_id]["check-1"].conclusion, "SUCCESS")

    // a second bind_pr with a different head is rejected at the state machine
    await assert.rejects(
      runExecutionController(root, { action: "bind_pr", execution_id: "E1", session_id: sid, repository: "owner/repo", pr_number: 158, candidate_id: candidate.candidate_id, head_sha: "head-b", base_branch: "main", base_sha: "base-1" }),
      /already bound|conflict/,
    )
  })
})
