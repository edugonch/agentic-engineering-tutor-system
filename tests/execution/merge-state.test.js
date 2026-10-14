import test from "node:test"
import assert from "node:assert/strict"
import { applyEvent, project, canStartMerge, canVerifyExternalMerge } from "../../src/execution/state.js"
import { findApprovedEpic, recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stableHash } from "../../src/execution/serialize.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { findPendingLaunchBinding } from "../../src/execution/launch-binding.js"
import { findWuExecution } from "../../src/execution/execution-query.js"

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

// A hand-constructed "ready" state for the pure gate.
function readyState(overrides = {}) {
  return {
    wu: { wu_id: "WU-01", completed: false },
    mandate: { merge_policy: "governed_auto", required_ci_checks: ["check-1"] },
    pr_binding: { repository: "o/r", pr_number: 158, candidate_id: "cand-1", head_sha: "head-a", base_sha: "base-1", base_branch: "main" },
    candidates: { "cand-1": { wu_id: "WU-01" } },
    reviews: { "cand-1": { verdict: "PASS", verification_evidence_ids: ["verified-receipt"] } },
    ci_evidence: { "cand-1": { "check-1": { head_sha: "head-a", conclusion: "SUCCESS" } } },
    dispatches: {},
    blocker: null,
    ...overrides,
  }
}

// A well-formed "ready" event sequence for the state machine.
function readyEvents(ev, { mergePolicy = "governed_auto", verdict = "PASS" } = {}) {
  return [
    ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 4, total_seconds: 100, merge_policy: mergePolicy, required_ci_checks: mergePolicy === "governed_auto" ? ["check-1"] : [] }),
    ev("WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }),
    ev("FREEZE_CANDIDATE", { candidate_id: "cand-1", manifest_hash: "m1", tree_hash: "t1", wu_id: "WU-01" }),
    ev("RECORD_REVIEW", { candidate_id: "cand-1", verdict, candidate_hashes: { manifest_hash: "m1", tree_hash: "t1" }, verification_evidence_ids: verdict === "PASS" ? ["ev-1"] : [], verified_check_ids: [], verification_contract_hash: null }),
    ev("BIND_PR", { repository: "o/r", pr_number: 158, candidate_id: "cand-1", head_sha: "head-a", base_branch: "main", base_sha: "base-1" }),
    ev("RECORD_CI", { candidate_id: "cand-1", head_sha: "head-a", check_identity: "check-1", conclusion: "SUCCESS" }),
  ]
}

// --- pure gate: canStartMerge ---
test("canStartMerge allows a fully-gated governed_auto merge", () => {
  assert.deepEqual(canStartMerge(readyState()), { allowed: true })
})

test("canStartMerge permits explicit no-CI while retaining local review and dispatch gates", () => {
  const noCI = readyState({ mandate: { merge_policy: "governed_auto", required_ci_checks: [] }, ci_evidence: {} })
  assert.deepEqual(canStartMerge(noCI), { allowed: true })
  assert.equal(canStartMerge({ ...noCI, reviews: {} }).allowed, false)
  assert.equal(canStartMerge({ ...noCI, dispatches: { pending: { status: "launched" } } }).allowed, false)
  assert.equal(canStartMerge({ ...noCI, pr_binding: null }).allowed, false)
})

test("canStartMerge rejects non-governed_auto policies", () => {
  assert.equal(canStartMerge(readyState({ mandate: { merge_policy: "human" } })).allowed, false)
  assert.match(canStartMerge(readyState({ mandate: { merge_policy: "human" } })).reason, /governed_auto/)
  assert.equal(canStartMerge(readyState({ mandate: { merge_policy: "none" } })).allowed, false)
  assert.equal(canStartMerge(readyState({ mandate: {} })).allowed, false) // omitted -> none
})

test("canStartMerge rejects missing/changed review", () => {
  assert.equal(canStartMerge(readyState({ reviews: {} })).allowed, false)
  assert.equal(canStartMerge(readyState({ reviews: { "cand-1": { verdict: "CHANGES_REQUIRED" } } })).allowed, false)
})

test("canStartMerge rejects missing/failed/stale CI", () => {
  assert.equal(canStartMerge(readyState({ ci_evidence: {} })).allowed, false)
  assert.equal(canStartMerge(readyState({ ci_evidence: { "cand-1": { "check-1": { head_sha: "head-a", conclusion: "FAILURE" } } } })).allowed, false)
  assert.equal(canStartMerge(readyState({ ci_evidence: { "cand-1": { "check-1": { head_sha: "stale", conclusion: "SUCCESS" } } } })).allowed, false)
})

test("canStartMerge rejects candidate/binding mismatch and unsettled dispatches", () => {
  assert.equal(canStartMerge(readyState({ pr_binding: { ...readyState().pr_binding, candidate_id: "cand-other" } })).allowed, false)
  assert.equal(canStartMerge(readyState({ dispatches: { d1: { status: "launched" } } })).allowed, false)
})

test("legacy receiptless PASS replays byte-identically but cannot authorize new work", async () => {
  const ev = makeBuilder()
  const events = readyEvents(ev)
  const oldReview = events.find(event => event.operation_type === "RECORD_REVIEW")
  oldReview.body.verification_evidence_ids = []
  oldReview.operation_hash = stableHash(oldReview.body)
  const originalLog = JSON.stringify(events)
  const state = project(events)
  assert.equal(state.reviews["cand-1"].verdict, "PASS")
  assert.deepEqual(state.reviews["cand-1"].verification_evidence_ids, [])
  assert.deepEqual(project(events), state)
  assert.equal(JSON.stringify(events), originalLog)
  assert.match(canStartMerge(state).reason, /lacks verification evidence/)
  assert.match(canVerifyExternalMerge({
    ...state, mandate: { merge_policy: "human", required_ci_checks: [] },
  }).reason, /lacks verification evidence/)

  const beforeReview = project(events.slice(0, 3))
  assert.throws(
    () => applyEvent(beforeReview, nextEvent(beforeReview, "RECORD_REVIEW", oldReview.body)),
    /PASS verdict requires verification evidence/,
  )
  assert.throws(() => applyEvent(state, nextEvent(state, "WU_COMPLETE", {
    candidate_id: "cand-1",
  })), /PASS review lacks verification evidence/)

  // An already merged/completed historical WU remains fully replayable.
  const priorCompleted = [...events,
    ev("MERGE_START", { attempt_id: "legacy-attempt" }),
    ev("MERGE_RECORD", { merge_commit_sha: "merged-1", merged_head_sha: "head-a" }),
    ev("MERGE_VERIFY", {}),
    ev("WU_COMPLETE", { candidate_id: "cand-1" }),
  ]
  const historic = project(priorCompleted)
  assert.equal(historic.wu.completed, true)
  assert.equal(historic.merge.status, "VERIFIED")
  assert.deepEqual(project(priorCompleted), historic)

  // Reproduce the controller's real snapshot() path with a V1 event log.
  const root = await mkdtemp(join(tmpdir(), "harness-legacy-review-"))
  try {
    await writeFile(join(root, "events.ndjson"), priorCompleted.map(event => JSON.stringify(event)).join("\n") + "\n")
    const controller = await createExecutionController({ dir: root })
    assert.deepEqual((await controller.snapshot()).state, historic)

    // Launch discovery scans every execution; a legacy log must not poison
    // delegation for a different, valid and still-active WU.
    const executionRoot = join(root, ".harness/execution/controller")
    const oldDir = join(executionRoot, "completed-old")
    const activeDir = join(executionRoot, "active-new")
    await mkdir(oldDir, { recursive: true })
    await mkdir(activeDir, { recursive: true })
    await writeFile(join(oldDir, "events.ndjson"), priorCompleted.map(event => JSON.stringify(event)).join("\n") + "\n")
    const currentEv = makeBuilder()
    const currentEvents = [
      currentEv("MANDATE_APPROVE", { mandate_id: "M2", max_wus: 1, total_seconds: 100 }),
      currentEv("WU_ACTIVATE", { wu_id: "WU-NEW", mandate_id: "M2" }),
    ]
    await writeFile(join(activeDir, "events.ndjson"), currentEvents.map(event => JSON.stringify(event)).join("\n") + "\n")
    const active = await findWuExecution(root, "WU-NEW")
    assert.equal(active.execution_id, "active-new")
    assert.equal(await findPendingLaunchBinding(root, "root", "harness-builder"), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- state machine: MERGE_START / RECORD / VERIFY ---
test("merge happy path reaches VERIFIED", () => {
  const ev = makeBuilder()
  const s = project(readyEvents(ev))
  const started = applyEvent(s, nextEvent(s, "MERGE_START", {}))
  assert.equal(started.merge.status, "STARTED")
  assert.equal(started.merge.expected_head_sha, "head-a")
  const recorded = applyEvent(started, nextEvent(started, "MERGE_RECORD", { merge_commit_sha: "merge-1", merged_head_sha: "head-a" }))
  assert.equal(recorded.merge.status, "RECORDED")
  const verified = applyEvent(recorded, nextEvent(recorded, "MERGE_VERIFY", {}))
  assert.equal(verified.merge.status, "VERIFIED")
})

test("governed_auto: WU_COMPLETE requires a verified merge", () => {
  const ev = makeBuilder()
  const s = project(readyEvents(ev))
  assert.throws(
    () => applyEvent(s, nextEvent(s, "WU_COMPLETE", { candidate_id: "cand-1" })),
    /merge policy governed_auto requires merge.status VERIFIED/,
  )
})

test("governed_auto: WU_COMPLETE accepted after merge VERIFIED", () => {
  const ev = makeBuilder()
  const s = project(readyEvents(ev))
  const started = applyEvent(s, nextEvent(s, "MERGE_START", {}))
  const recorded = applyEvent(started, nextEvent(started, "MERGE_RECORD", { merge_commit_sha: "merge-1", merged_head_sha: "head-a" }))
  const verified = applyEvent(recorded, nextEvent(recorded, "MERGE_VERIFY", {}))
  const done = applyEvent(verified, nextEvent(verified, "WU_COMPLETE", { candidate_id: "cand-1" }))
  assert.equal(done.wu.completed, true)
})

test("none: WU_COMPLETE keeps V1 behavior (no merge required)", () => {
  const ev = makeBuilder()
  const s = project(readyEvents(ev, { mergePolicy: "none" }))
  const done = applyEvent(s, nextEvent(s, "WU_COMPLETE", { candidate_id: "cand-1" }))
  assert.equal(done.wu.completed, true)
})

test("human: WU_COMPLETE requires a verified HUMAN_EXTERNAL merge", () => {
  const ev = makeBuilder()
  const s = project(readyEvents(ev, { mergePolicy: "human" }))
  assert.throws(
    () => applyEvent(s, nextEvent(s, "WU_COMPLETE", { candidate_id: "cand-1" })),
    /merge policy human requires merge.status VERIFIED/,
  )
})

test("human: WU_COMPLETE accepted after a verified HUMAN_EXTERNAL merge", () => {
  const ev = makeBuilder()
  const s = project(readyEvents(ev, { mergePolicy: "human" }))
  const recorded = applyEvent(s, nextEvent(s, "MERGE_EXTERNAL_RECORD", { merge_commit_sha: "merge-1", merged_head_sha: "head-a" }))
  assert.equal(recorded.merge.source, "HUMAN_EXTERNAL")
  const verified = applyEvent(recorded, nextEvent(recorded, "MERGE_VERIFY", {}))
  assert.equal(verified.merge.status, "VERIFIED")
  const done = applyEvent(verified, nextEvent(verified, "WU_COMPLETE", { candidate_id: "cand-1" }))
  assert.equal(done.wu.completed, true)
})

test("MERGE_START is blocked by the gate (e.g. human policy)", () => {
  const ev = makeBuilder()
  const s = project(readyEvents(ev, { mergePolicy: "human" }))
  assert.throws(() => applyEvent(s, nextEvent(s, "MERGE_START", {})), /governed_auto/)
})

test("MERGE_RECORD without MERGE_START is rejected", () => {
  const ev = makeBuilder()
  const s = project(readyEvents(ev))
  assert.throws(() => applyEvent(s, nextEvent(s, "MERGE_RECORD", { merge_commit_sha: "x", merged_head_sha: "head-a" })), /requires MERGE_START/)
})

test("MERGE_VERIFY rejects a merged head that does not match the expected head", () => {
  const ev = makeBuilder()
  const s = project(readyEvents(ev))
  const started = applyEvent(s, nextEvent(s, "MERGE_START", {}))
  const recorded = applyEvent(started, nextEvent(started, "MERGE_RECORD", { merge_commit_sha: "merge-1", merged_head_sha: "head-BAD" }))
  assert.throws(() => applyEvent(recorded, nextEvent(recorded, "MERGE_VERIFY", {})), /does not match/)
})

test("historical V1 mandate (no merge_policy) defaults to none and cannot merge", () => {
  const ev = makeBuilder()
  const events = [
    ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 4, total_seconds: 100 }),
    ev("WU_ACTIVATE", { wu_id: "WU-01", mandate_id: "M1" }),
    ev("FREEZE_CANDIDATE", { candidate_id: "cand-1", manifest_hash: "m1", tree_hash: "t1", wu_id: "WU-01" }),
    ev("RECORD_REVIEW", { candidate_id: "cand-1", verdict: "PASS", candidate_hashes: { manifest_hash: "m1", tree_hash: "t1" }, verification_evidence_ids: ["ev-1"], verified_check_ids: [], verification_contract_hash: null }),
    ev("BIND_PR", { repository: "o/r", pr_number: 158, candidate_id: "cand-1", head_sha: "head-a", base_branch: "main", base_sha: "base-1" }),
    ev("RECORD_CI", { candidate_id: "cand-1", head_sha: "head-a", check_identity: "check-1", conclusion: "SUCCESS" }),
  ]
  const s = project(events)
  assert.equal(s.mandate.merge_policy, "none")
  assert.throws(() => applyEvent(s, nextEvent(s, "MERGE_START", {})), /governed_auto/)
})

// --- merge_policy + required_ci_checks parsing via findApprovedEpic ---
test("merge_policy + required_ci_checks parsing (valid, default, and rejections)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-merge-policy-"))
  try {
    // governed_auto with valid required_ci_checks
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: "epic-auto", status: "APPROVED", owner_confirmed: true,
      title: "Test Epic auto", content: 'epic\nexecution_mandate: {"max_wus": 4, "total_seconds": 100, "merge_policy": "governed_auto", "required_ci_checks": ["check-1"]}',
      source_refs: ["https://example.com/epic-source"],
    })
    const auto = await findApprovedEpic(root, "epic-auto")
    assert.equal(auto.mandate.merge_policy, "governed_auto")
    assert.deepEqual(auto.mandate.required_ci_checks, ["check-1"])

    // default (no merge_policy) → none, empty required_ci_checks
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: "epic-default", status: "APPROVED", owner_confirmed: true,
      title: "Test Epic default", content: 'epic\nexecution_mandate: {"max_wus": 4, "total_seconds": 100}',
      source_refs: ["https://example.com/epic-source"],
    })
    const dflt = await findApprovedEpic(root, "epic-default")
    assert.equal(dflt.mandate.merge_policy, "none")
    assert.deepEqual(dflt.mandate.required_ci_checks, [])

    // Explicit empty required_ci_checks must be accepted as CI disabled.
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: "epic-empty", status: "APPROVED", owner_confirmed: true,
      title: "Test Epic empty", content: 'epic\nexecution_mandate: {"max_wus": 4, "total_seconds": 100, "merge_policy": "governed_auto", "required_ci_checks": []}',
      source_refs: ["https://example.com/epic-source"],
    })
    const noCI = await findApprovedEpic(root, "epic-empty")
    assert.deepEqual(noCI.mandate.required_ci_checks, [])

    // non-string/empty entry → rejected (not silently filtered)
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: "epic-badtype", status: "APPROVED", owner_confirmed: true,
      title: "Test Epic badtype", content: 'epic\nexecution_mandate: {"max_wus": 4, "total_seconds": 100, "merge_policy": "governed_auto", "required_ci_checks": [""]}',
      source_refs: ["https://example.com/epic-source"],
    })
    await assert.rejects(findApprovedEpic(root, "epic-badtype"), /missing or invalid machine-readable execution_mandate/)

    // duplicate entry → rejected
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: "epic-dup", status: "APPROVED", owner_confirmed: true,
      title: "Test Epic dup", content: 'epic\nexecution_mandate: {"max_wus": 4, "total_seconds": 100, "merge_policy": "governed_auto", "required_ci_checks": ["check-1","check-1"]}',
      source_refs: ["https://example.com/epic-source"],
    })
    await assert.rejects(findApprovedEpic(root, "epic-dup"), /missing or invalid machine-readable execution_mandate/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
