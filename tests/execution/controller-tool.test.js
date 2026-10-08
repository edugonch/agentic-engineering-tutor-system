import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { createVerificationReceipt, writeVerificationReceipt } from "../../src/execution/verification-results.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-tool-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

const CONTRACT = {
  commands: [{ id: "check-1", program: "node", args: ["-e", "process.exit(0)"] }],
  environment: { network_policy: "UNRESTRICTED" },
  source_wu_id: "WU-01",
}

// Freeze a real file (with a verification contract) into the registry.
async function seedCandidate(root, filename = "change.txt") {
  await writeFile(join(root, filename), "hello")
  const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })
  const candidate = await freezeCandidate(root, { paths: [filename], verification_contract: CONTRACT })
  await registry.store(candidate)
  return candidate
}

// Persist an immutable receipt bound to the candidate and return its evidence id.
async function seedReceipt(root, candidate, { checkId = "check-1", status = "PASS" } = {}) {
  return writeVerificationReceipt(join(root, ".harness", "execution", "verification-results"), createVerificationReceipt({
    candidate_id: candidate.candidate_id,
    verification_contract_hash: candidate.manifest.verification_contract.contract_hash,
    check_id: checkId,
    status,
    exitCode: status === "PASS" ? 0 : 1,
    fingerprint: { node: "test", cwd: "/tmp", timestamp: new Date().toISOString() },
  }))
}

// Freeze a real file with an explicit multi-check contract.
async function seedCandidateWithContract(root, commands, filename = "change.txt") {
  await writeFile(join(root, filename), "hello")
  const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })
  const candidate = await freezeCandidate(root, { paths: [filename], verification_contract: { commands, environment: { network_policy: "UNRESTRICTED" }, source_wu_id: "WU-01" } })
  await registry.store(candidate)
  return candidate
}

// Record an Epic artifact into the knowledge index (APPROVED or RAW), with a
// machine-readable execution_mandate envelope.
async function seedEpicArtifact(root, { artifactId = "epic-001", status = "APPROVED", maxWus = 4, totalSeconds = 100 } = {}) {
  return recordKnowledgeArtifact(root, {
    artifact_type: "epic",
    artifact_id: artifactId,
    title: "Test Epic",
    content: `test epic\nexecution_mandate: {"max_wus": ${maxWus}, "total_seconds": ${totalSeconds}}`,
    status,
    owner_confirmed: true,
    source_refs: ["https://example.com/epic-source"],
  })
}

// Seed an approved Epic and approve a governed mandate from it (replaces legacy init for WU tests).
async function governed(root, sid, executionId = "E1") {
  await seedEpicArtifact(root)
  await runExecutionController(root, { action: "approve_mandate", execution_id: executionId, session_id: sid, epic_artifact_id: "epic-001" })
}

test("init → status → verify roundtrip", async () => {
  await withRoot(async (root) => {
    const init = await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    assert.equal(init.commit_status, "committed")
    assert.equal(init.revision, 1)

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.revision, 1)
    assert.equal(status.budget.total_seconds, 100)
    assert.equal(status.budget.available_seconds, 100)

    const v = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(v.passed, true)
  })
})

test("full dispatch lifecycle: reserve → launch → finish → reconcile → verify", async () => {
  await withRoot(async (root) => {
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 10 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })
    await runExecutionController(root, { action: "record_launch", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", launch_session_id: "ext-1" })
    await runExecutionController(root, { action: "record_finish", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", result: "ok" })

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.dispatches[0].status, "finished")

    const rec = await runExecutionController(root, { action: "reconcile", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })
    assert.equal(rec.found, true)

    const after = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(after.dispatches[0].status, "result_reconciled")
    assert.equal(after.budget.used_seconds, 10)
    assert.equal(after.budget.reserved_seconds, 0)

    const v = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(v.passed, true)
  })
})

test("ambiguous path: prepare_launch → mark_ambiguous → recover → verify", async () => {
  await withRoot(async (root) => {
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 5 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })
    await runExecutionController(root, { action: "mark_ambiguous", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })

    const recover = await runExecutionController(root, { action: "recover", execution_id: "E1" })
    assert.deepEqual(recover.classification.ambiguous, ["d1"])
    assert.deepEqual(recover.plan.requires_investigation, ["d1"])

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.dispatches[0].status, "ambiguous")
    assert.equal(status.budget.reserved_seconds, 5) // still held

    const v = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(v.passed, true)
  })
})

test("resolve_ambiguous_launch binds recovered session without relaunch or budget release", async () => {
  await withRoot(async (root) => {
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 5 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })
    await runExecutionController(root, { action: "mark_ambiguous", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })

    const recovered = await runExecutionController(root, {
      action: "resolve_ambiguous_launch",
      execution_id: "E1",
      session_id: "ses-1",
      dispatch_id: "d1",
      launch_session_id: "ses-real-1",
      recovery_evidence: "Observed the actual external child session created by the original launch.",
    })
    assert.equal(recovered.commit_status, "committed")
    assert.equal(recovered.dispatches[0].status, "launched")
    assert.equal(recovered.dispatches[0].session_id, "ses-real-1")
    assert.equal(recovered.budget.reserved_seconds, 5)

    const replay = await runExecutionController(root, {
      action: "resolve_ambiguous_launch",
      execution_id: "E1",
      session_id: "ses-1",
      dispatch_id: "d1",
      launch_session_id: "ses-real-1",
      recovery_evidence: "Observed the actual external child session created by the original launch.",
    })
    assert.equal(replay.commit_status, "replayed")

    await assert.rejects(
      runExecutionController(root, {
        action: "resolve_ambiguous_launch",
        execution_id: "E1",
        session_id: "ses-1",
        dispatch_id: "d1",
        launch_session_id: "ses-different",
        recovery_evidence: "different claim",
      }),
      /not ambiguous/,
    )

    const v = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(v.passed, true)
  })
})

test("a repeated reserve with the same dispatch_id is a replay, not a double reservation", async () => {
  await withRoot(async (root) => {
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    const first = await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 10 })
    assert.equal(first.commit_status, "committed")

    const second = await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 10 })
    assert.equal(second.commit_status, "replayed")

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.budget.reserved_seconds, 10) // not 20
  })
})

test("release is refused for a launched dispatch (no force release)", async () => {
  await withRoot(async (root) => {
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 5 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })
    await runExecutionController(root, { action: "record_launch", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", launch_session_id: "ext-1" })

    await assert.rejects(
      runExecutionController(root, { action: "release", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" }),
      /never-launched/,
    )
  })
})

test("release succeeds for a never-launched dispatch", async () => {
  await withRoot(async (root) => {
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "ses-1", total_seconds: 100 })
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1", reserved_seconds: 5 })
    const rel = await runExecutionController(root, { action: "release", execution_id: "E1", session_id: "ses-1", dispatch_id: "d1" })
    assert.equal(rel.commit_status, "committed")

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.dispatches[0].status, "released")
    assert.equal(status.budget.reserved_seconds, 0)

    const v = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(v.passed, true)
  })
})

test("WU lifecycle: activate_wu → record_candidate (registry) → record_review (evidence) → checkpoint → complete_wu → verify", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    const candidate = await seedCandidate(root)
    const evidenceId = await seedReceipt(root, candidate)

    await governed(root, sid)

    const act = await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    assert.equal(act.commit_status, "committed")
    assert.equal(act.wu.origin, "DERIVED")
    assert.equal(act.wu.execution_authorization, "AUTHORIZED_BY_MANDATE")

    const freeze = await runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id })
    assert.equal(freeze.commit_status, "committed")
    assert.equal(freeze.candidates[candidate.candidate_id].wu_id, "WU-01")

    const review = await runExecutionController(root, { action: "record_review", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id, verdict: "PASS", reviewer: "harness-reviewer", verification_evidence_ids: [evidenceId] })
    assert.equal(review.commit_status, "committed")
    assert.deepEqual(review.reviews[candidate.candidate_id].verification_evidence_ids, [evidenceId])

    const checkpoint = await runExecutionController(root, { action: "checkpoint", execution_id: "E1", session_id: sid, checkpoint_id: "ck-1", note: "frozen+reviewed" })
    assert.equal(checkpoint.commit_status, "committed")

    const complete = await runExecutionController(root, { action: "complete_wu", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id })
    assert.equal(complete.commit_status, "committed")
    assert.equal(complete.wu.completed, true)

    const v = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(v.passed, true)
  })
})

test("activate_wu with a non-matching mandate_id is rejected (authority is mandate-bound)", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await governed(root, sid)
    await assert.rejects(
      runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "WRONG" }),
      /mandate mismatch/,
    )
  })
})

test("activate_wu rejects a second WU while the first is incomplete", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await governed(root, sid)
    await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    await assert.rejects(
      runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-02", mandate_id: "E1-MANDATE-001" }),
      /not complete/,
    )
  })
})

test("record_review without verification evidence is rejected", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    const candidate = await seedCandidate(root)
    await governed(root, sid)
    await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    await runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id })
    await assert.rejects(
      runExecutionController(root, { action: "record_review", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id, verdict: "PASS", reviewer: "harness-reviewer" }),
      /requires verification_evidence_ids/,
    )
  })
})

test("record_review with evidence belonging to a different candidate is rejected", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    const candidateA = await seedCandidate(root, "a.txt")
    const candidateB = await seedCandidate(root, "b.txt")
    const evidenceA = await seedReceipt(root, candidateA)
    await governed(root, sid)
    await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    await runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: candidateB.candidate_id })
    await assert.rejects(
      runExecutionController(root, { action: "record_review", execution_id: "E1", session_id: sid, candidate_id: candidateB.candidate_id, verdict: "PASS", reviewer: "harness-reviewer", verification_evidence_ids: [evidenceA] }),
      /belongs to /,
    )
  })
})

test("record_candidate with an unknown candidate_id is rejected (registry-bound)", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await governed(root, sid)
    await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    await assert.rejects(
      runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: "cand-fake" }),
      /not present in the candidate registry/,
    )
  })
})

test("complete_wu without a review is rejected", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    const candidate = await seedCandidate(root)
    await governed(root, sid)
    await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    await runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id })
    await assert.rejects(
      runExecutionController(root, { action: "complete_wu", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id }),
      /no review recorded/,
    )
  })
})

test("complete_wu with a CHANGES_REQUIRED review is rejected", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    const candidate = await seedCandidate(root)
    const evidenceId = await seedReceipt(root, candidate)
    await governed(root, sid)
    await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    await runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id })
    await runExecutionController(root, { action: "record_review", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id, verdict: "CHANGES_REQUIRED", reviewer: "harness-reviewer", verification_evidence_ids: [evidenceId] })
    await assert.rejects(
      runExecutionController(root, { action: "complete_wu", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id }),
      /verdict is CHANGES_REQUIRED/,
    )
  })
})

test("complete_wu with an unsettled dispatch is rejected (budget must be liquidated)", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    const candidate = await seedCandidate(root)
    const evidenceId = await seedReceipt(root, candidate)
    await governed(root, sid)
    await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    await runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id })
    await runExecutionController(root, { action: "record_review", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id, verdict: "PASS", reviewer: "harness-reviewer", verification_evidence_ids: [evidenceId] })
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: sid, dispatch_id: "d1", reserved_seconds: 5 })
    await assert.rejects(
      runExecutionController(root, { action: "complete_wu", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id }),
      /not settled/,
    )
  })
})

test("record_review PASS with incomplete verification coverage is rejected", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    const candidate = await seedCandidateWithContract(root, [
      { id: "unit", program: "node", args: ["-e", "process.exit(0)"] },
      { id: "lint", program: "node", args: ["-e", "process.exit(0)"] },
    ])
    const unitEvidence = await seedReceipt(root, candidate, { checkId: "unit", status: "PASS" })
    await governed(root, sid)
    await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    await runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id })
    await assert.rejects(
      runExecutionController(root, { action: "record_review", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id, verdict: "PASS", reviewer: "harness-reviewer", verification_evidence_ids: [unitEvidence] }),
      /coverage/,
    )
  })
})

test("record_review CHANGES_REQUIRED with a FAIL receipt is accepted", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    const candidate = await seedCandidate(root)
    const failEvidence = await seedReceipt(root, candidate, { status: "FAIL" })
    await governed(root, sid)
    await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    await runExecutionController(root, { action: "record_candidate", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id })
    const review = await runExecutionController(root, { action: "record_review", execution_id: "E1", session_id: sid, candidate_id: candidate.candidate_id, verdict: "CHANGES_REQUIRED", reviewer: "harness-reviewer", verification_evidence_ids: [failEvidence] })
    assert.equal(review.commit_status, "committed")
  })
})

test("approve_mandate without an approved Epic is rejected", async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      runExecutionController(root, { action: "approve_mandate", execution_id: "E1", session_id: "ses-1", epic_artifact_id: "epic-nonexistent" }),
      /No APPROVED Epic artifact/,
    )
  })
})

test("approve_mandate with a non-approved (RAW) Epic is rejected", async () => {
  await withRoot(async (root) => {
    await seedEpicArtifact(root, { status: "RAW" })
    await assert.rejects(
      runExecutionController(root, { action: "approve_mandate", execution_id: "E1", session_id: "ses-1", epic_artifact_id: "epic-001" }),
      /No APPROVED Epic artifact/,
    )
  })
})

test("approve_mandate with an approved Epic binds source authority and derives its envelope", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await seedEpicArtifact(root, { status: "APPROVED", maxWus: 1, totalSeconds: 900 })
    const res = await runExecutionController(root, { action: "approve_mandate", execution_id: "E1", session_id: sid, epic_artifact_id: "epic-001", max_wus: 50, total_seconds: 999999 })
    assert.equal(res.commit_status, "committed")
    assert.equal(res.source_artifact_id, "epic-001")
    // envelope is derived from the artifact, not the caller's overrides
    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.mandate.max_wus, 1)
    assert.equal(status.budget.total_seconds, 900)
    const act = await runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" })
    assert.equal(act.commit_status, "committed")
  })
})

test("activate_wu rejects a legacy init (PROBE) mandate", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: sid, total_seconds: 100 })
    await assert.rejects(
      runExecutionController(root, { action: "activate_wu", execution_id: "E1", session_id: sid, wu_id: "WU-01", mandate_id: "E1-MANDATE-001" }),
      /OWNER_APPROVED_EPIC/,
    )
  })
})

test("approve_mandate rejects an approved Epic whose archive was modified after approval", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await seedEpicArtifact(root)
    await writeFile(join(root, ".harness", "epics", "epic-001.md"), "tampered")
    await assert.rejects(
      runExecutionController(root, { action: "approve_mandate", execution_id: "E1", session_id: sid, epic_artifact_id: "epic-001" }),
      /APPROVED_EPIC_INTEGRITY_MISMATCH/,
    )
  })
})

test("approve_mandate rejects an approved Epic replaced by a symlink", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await seedEpicArtifact(root)
    const path = join(root, ".harness", "epics", "epic-001.md")
    await rm(path)
    await symlink("/etc/passwd", path)
    await assert.rejects(
      runExecutionController(root, { action: "approve_mandate", execution_id: "E1", session_id: sid, epic_artifact_id: "epic-001" }),
      /APPROVED_EPIC_INTEGRITY_MISMATCH/,
    )
  })
})

test("block contract persists a typed class and its reason", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await governed(root, sid)
    const res = await runExecutionController(root, { action: "block", execution_id: "E1", session_id: sid, class: "BLOCKED_TOOLING", reason: "transient tooling outage" })
    assert.equal(res.commit_status, "committed")
    assert.equal(res.blocker.class, "BLOCKED_TOOLING")
    assert.equal(res.blocker.reason, "transient tooling outage")
  })
})

test("block contract rejects a missing class, missing reason, and an unknown class", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await governed(root, sid)

    await assert.rejects(
      runExecutionController(root, { action: "block", execution_id: "E1", session_id: sid, reason: "no class" }),
      /requires class/,
    )
    await assert.rejects(
      runExecutionController(root, { action: "block", execution_id: "E1", session_id: sid, class: "BLOCKED_TOOLING" }),
      /requires reason/,
    )
    // A reviewer-outcome name is not a BLOCKER_CLASSES value; it is rejected,
    // not silently persisted.
    await assert.rejects(
      runExecutionController(root, { action: "block", execution_id: "E1", session_id: sid, class: "REVIEW_ENVIRONMENT_BLOCKED", reason: "not a blocker class" }),
      /Unknown blocker class/,
    )
  })
})
