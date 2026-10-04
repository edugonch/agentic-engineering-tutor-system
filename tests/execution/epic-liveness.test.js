import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { runCandidateVerification } from "../../src/execution/verification.js"
import { verificationContractHash } from "../../src/execution/verification-contract.js"
import { createVerificationReceipt, writeVerificationReceipt } from "../../src/execution/verification-results.js"
import { sha256 } from "../../src/execution/serialize.js"

const contractText = "WU: support the approved behavior, within payload.txt only."
const sourceHash = sha256(contractText)
const verification = {
  source_wu_id: "WU-LIVENESS",
  source_wu_hash: sourceHash,
  commands: [{ id: "check", program: process.execPath, args: ["-e", "process.exit(0)"] }],
}

function finding(id, severity = "major") {
  return {
    id,
    severity,
    location: "payload.txt",
    evidence: `finding ${id}`,
    impact: "wrong behavior",
    correction: `fix ${id}`,
  }
}

function makePolicy(overrides = {}, wuIds = null) {
  const policy = {
    version: 1,
    max_repair_cycles: 3,
    repair_convergence_budget: 5,
    wu_id: "WU-LIVENESS",
    wu_contract_path: "wu.md",
    wu_contract_hash: sourceHash,
    allowed_paths: ["payload.txt"],
    verification_contract_hash: verificationContractHash(verification),
    build_seconds: 10,
    repair_seconds: 10,
    review_seconds: 10,
    recovery_actions: [],
    ...overrides,
  }
  if (wuIds) policy.wu_ids = wuIds
  return policy
}

async function fixture(fn, { seconds = 300, policyOverrides = {}, wuQueue = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-liveness-"))
  try {
    await writeFile(join(root, "wu.md"), contractText)
    const mandate = {
      max_wus: wuQueue ? wuQueue.length : 1,
      total_seconds: seconds,
      repair_policy: makePolicy(policyOverrides, wuQueue ? wuQueue.map((w) => w.wu_id) : null),
    }
    if (wuQueue) mandate.wu_queue = wuQueue
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic",
      artifact_id: "epic-liveness",
      status: "APPROVED",
      owner_confirmed: true,
      title: "Test-only liveness authority",
      source_refs: ["wu.md"],
      content: `execution_mandate: ${JSON.stringify(mandate)}`,
    })
    const call = (input) => runExecutionController(root, { execution_id: "E", session_id: "owner", ...input })
    await call({ action: "approve_mandate", epic_artifact_id: "epic-liveness" })
    await call({ action: "activate_wu", wu_id: wuQueue ? wuQueue[0].wu_id : "WU-LIVENESS", mandate_id: "E-MANDATE-001" })

    const registry = createCandidateRegistry({ dir: join(root, ".harness/execution") })
    const candidate = async (content, paths = ["payload.txt"], wuId = "WU-LIVENESS") => {
      await writeFile(join(root, "payload.txt"), content)
      const vc = { ...verification, source_wu_id: wuId }
      const c = await freezeCandidate(root, { paths, verification_contract: vc })
      await registry.store(c)
      return c
    }

    const receipt = async (c) =>
      writeVerificationReceipt(
        join(root, ".harness/execution/verification-results"),
        createVerificationReceipt(await runCandidateVerification(c, "check")),
      )

    const dispatch = async (id, purpose, cid, result = "done", secondsArg = 10) => {
      await call({ action: "reserve", dispatch_id: id, purpose, candidate_id: cid, reserved_seconds: secondsArg })
      await call({ action: "prepare_launch", dispatch_id: id })
      await call({ action: "record_launch", dispatch_id: id, launch_session_id: `session-${id}` })
      await call({ action: "record_finish", dispatch_id: id, result })
      await call({ action: "reconcile", dispatch_id: id })
    }

    const review = async (c, verdict, id = `review-${c.candidate_id}`, findings = [finding("a")]) => {
      await call({ action: "reserve", dispatch_id: id, purpose: "REVIEW", candidate_id: c.candidate_id, reserved_seconds: 10 })
      await call({ action: "prepare_launch", dispatch_id: id })
      await call({ action: "record_launch", dispatch_id: id, launch_session_id: `session-${id}` })
      const evidence = await receipt(c)
      await call({ action: "record_finish", dispatch_id: id, result: "review complete" })
      await call({ action: "reconcile", dispatch_id: id })
      return call({
        action: "record_review",
        candidate_id: c.candidate_id,
        verdict,
        reviewer: `session-${id}`,
        dispatch_id: id,
        findings: verdict === "PASS" ? [] : findings,
        verification_evidence_ids: [evidence],
      })
    }

    const authorize = (candidateId, dispatchId, hypothesis, progressEvidenceIds) =>
      call({
        action: "authorize_repair",
        candidate_id: candidateId,
        dispatch_id: dispatchId,
        hypothesis,
        progress_evidence_ids: progressEvidenceIds,
      })

    const restart = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { runExecutionController } from ${JSON.stringify(new URL("../../src/execution/controller-tool.js", import.meta.url).href)}; console.log(JSON.stringify(await runExecutionController(${JSON.stringify(root)}, {action:'recover',execution_id:'E'})))`,
          ],
          { encoding: "utf8" },
        ),
      )

    await fn({ root, call, candidate, receipt, dispatch, review, authorize, restart })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function buildAndReject(call, candidate, dispatch, review) {
  return async (content, findings) => {
    await dispatch("build", "BUILD", null, "done")
    const c = await candidate(content)
    await call({ action: "record_candidate", candidate_id: c.candidate_id, dispatch_id: "build" })
    return { candidate: c, reviewResult: await review(c, "CHANGES_REQUIRED", `review-${c.candidate_id}`, findings) }
  }
}

// Scenario A — first bounded review rework continues autonomously.
test("Scenario A: first CHANGES_REQUIRED triggers an autonomous repair cycle", async () =>
  fixture(async ({ call, candidate, dispatch, review }) => {
    const first = buildAndReject(call, candidate, dispatch, review)
    const { candidate: a, reviewResult } = await first("A", [finding("quote-preview")])
    assert.equal(reviewResult.reviews[a.candidate_id].verdict, "CHANGES_REQUIRED")

    const auth = await call({
      action: "authorize_repair",
      candidate_id: a.candidate_id,
      dispatch_id: "repair",
      hypothesis: "add canonicalization check",
      progress_evidence_ids: ["quote-preview"],
    })
    assert.equal(auth.wu.repair_cycle_count, 1)
    assert.equal(auth.blocker, null)

    await dispatch("repair", "REPAIR", a.candidate_id)
    const b = await candidate("B")
    await call({ action: "record_candidate", candidate_id: b.candidate_id, dispatch_id: "repair" })
    const pass = await review(b, "PASS", "review-b", [])
    assert.equal(pass.wu.current_candidate_id, b.candidate_id)
    assert.equal(pass.reviews[b.candidate_id].verdict, "PASS")
  }))

// Scenario B — multiple bounded repair cycles converge.
test("Scenario B: progressing repairs continue until PASS without owner interruption", async () =>
  fixture(async ({ call, candidate, dispatch, review }) => {
    const buildReject = buildAndReject(call, candidate, dispatch, review)

    // Cycle 1: 2 major findings
    const { candidate: a } = await buildReject("A", [finding("quote-preview"), finding("supersession-identity")])
    await call({ action: "authorize_repair", candidate_id: a.candidate_id, dispatch_id: "repair-1", hypothesis: "fix both", progress_evidence_ids: ["quote-preview", "supersession-identity"] })
    await dispatch("repair-1", "REPAIR", a.candidate_id)
    const b = await candidate("B")
    await call({ action: "record_candidate", candidate_id: b.candidate_id, dispatch_id: "repair-1" })
    await review(b, "CHANGES_REQUIRED", "review-b", [finding("supersession-identity")])

    // Cycle 2: 1 remaining major finding (strict progress)
    await call({ action: "authorize_repair", candidate_id: b.candidate_id, dispatch_id: "repair-2", hypothesis: "add predecessor identity", progress_evidence_ids: ["supersession-identity"] })
    await dispatch("repair-2", "REPAIR", b.candidate_id)
    const c = await candidate("C")
    await call({ action: "record_candidate", candidate_id: c.candidate_id, dispatch_id: "repair-2" })
    const pass = await review(c, "PASS", "review-c", [])

    assert.equal(pass.wu.repair_cycle_count, 2)
    assert.equal(pass.reviews[c.candidate_id].verdict, "PASS")
    assert.equal(pass.blocker, null)
  }))

// Scenario C — non-converging loop.
test("Scenario C: repeated identical semantic finding stops with NON_CONVERGING_REWORK", async () =>
  fixture(async ({ call, candidate, dispatch, review }) => {
    const buildReject = buildAndReject(call, candidate, dispatch, review)
    const { candidate: a } = await buildReject("A", [finding("quote-preview")])
    await call({ action: "authorize_repair", candidate_id: a.candidate_id, dispatch_id: "repair-1", hypothesis: "attempt 1", progress_evidence_ids: ["quote-preview"] })
    await dispatch("repair-1", "REPAIR", a.candidate_id)
    const b = await candidate("B")
    await call({ action: "record_candidate", candidate_id: b.candidate_id, dispatch_id: "repair-1" })
    const stop = await review(b, "CHANGES_REQUIRED", "review-b", [finding("quote-preview")])

    assert.equal(stop.blocker.class, "NO_PROGRESS")
    assert.ok(/REPEATED_IDENTICAL_FAILURE|NON_CONVERGING_REWORK/i.test(stop.blocker.reason))
    assert.ok(stop.blocker.evidence || stop.blocker.failure_signature, "blocker must carry evidence")
    await assert.rejects(call({ action: "authorize_repair", candidate_id: b.candidate_id, dispatch_id: "repair-2", hypothesis: "attempt 2", progress_evidence_ids: ["quote-preview"] }), /NO_PROGRESS|blocked|terminal/i)
  }))

// Scenario D — baseline CI failure.
test("Scenario D: CI failure only in unchanged baseline files classifies as BASELINE_REMEDIATION_REQUIRED", async () =>
  fixture(async ({ call, candidate, dispatch, review }) => {
    await dispatch("build", "BUILD", null, "done")
    const c = await candidate("A")
    await call({ action: "record_candidate", candidate_id: c.candidate_id, dispatch_id: "build" })

    const stop = await call({
      action: "ci_classify",
      candidate_id: c.candidate_id,
      check_id: "check",
      status: "FAIL",
      failing_files: [{ path: "preexisting-broken.txt", classification: "BASELINE_UNCHANGED" }],
    })
    assert.equal(stop.blocker.class, "BASELINE_REMEDIATION_REQUIRED")
    assert.ok(stop.blocker.reason.includes("baseline"))
  }))

// Scenario E — candidate-caused CI failure.
test("Scenario E: candidate-caused CI failure triggers normal repair", async () =>
  fixture(async ({ call, candidate, dispatch, review }) => {
    await dispatch("build", "BUILD", null, "done")
    const c = await candidate("A")
    await call({ action: "record_candidate", candidate_id: c.candidate_id, dispatch_id: "build" })

    await call({
      action: "ci_classify",
      candidate_id: c.candidate_id,
      check_id: "check",
      status: "FAIL",
      failing_files: [{ path: "payload.txt", classification: "CANDIDATE_CHANGED" }],
    })

    const s = await call({ action: "status" })
    assert.equal(s.blocker, null, "candidate-caused failure should not create a blocker")
    assert.equal(s.wu.current_candidate_id, c.candidate_id)
  }))

// Scenario F — business policy missing.
test("Scenario F: business-policy finding stops with OWNER_DECISION_REQUIRED", async () =>
  fixture(async ({ call, candidate, dispatch, review }) => {
    const buildReject = buildAndReject(call, candidate, dispatch, review)
    const { candidate: a } = await buildReject("A", [{ ...finding("policy"), severity: "policy", evidence: "requires product owner decision" }])
    const stop = await call({ action: "request_owner_decision", blocker_id: "policy-1", reason: " unresolved product policy" })
    assert.equal(stop.blocker.class, "OWNER_DECISION_REQUIRED")
  }))

// Scenario G — accepted WU continuation.
test("Scenario G: after WU acceptance, EPIC_CONTINUE activates the next authorized WU", async () =>
  fixture(
    async ({ call, candidate, dispatch, review }) => {
      await dispatch("build", "BUILD", null, "done")
      const c = await candidate("A", ["payload.txt"], "WU-1")
      await call({ action: "record_candidate", candidate_id: c.candidate_id, dispatch_id: "build" })
      await review(c, "PASS", "review-1", [])
      await call({ action: "complete_wu", candidate_id: c.candidate_id })

      const continued = await call({ action: "epic_continue" })
      assert.equal(continued.wu.wu_id, "WU-2")
      assert.equal(continued.epic.continuation_state, "ACTIVE")
      assert.ok(continued.epic.last_jit_refresh)
    },
    {
      seconds: 500,
      wuQueue: [
        { wu_id: "WU-1", wu_contract_path: "wu.md", dependencies: [] },
        { wu_id: "WU-2", wu_contract_path: "wu.md", dependencies: ["WU-1"] },
      ],
    },
  ))

// Scenario H — true Epic completion.
test("Scenario H: all WUs accepted yields EPIC_COMPLETE", async () =>
  fixture(
    async ({ call, candidate, dispatch, review }) => {
      for (const wuId of ["WU-1", "WU-2"]) {
        await dispatch("build", "BUILD", null, "done")
        const c = await candidate(wuId, ["payload.txt"], wuId)
        await call({ action: "record_candidate", candidate_id: c.candidate_id, dispatch_id: "build" })
        await review(c, "PASS", `review-${wuId}`, [])
        await call({ action: "complete_wu", candidate_id: c.candidate_id })
        if (wuId === "WU-1") await call({ action: "epic_continue" })
      }

      const finished = await call({ action: "complete", result: "EPIC_COMPLETE" })
      assert.equal(finished.completed, true)
      assert.equal(finished.completion.result, "EPIC_COMPLETE")
      assert.deepEqual(finished.epic.completed_wu_ids, ["WU-1", "WU-2"])
    },
    {
      seconds: 800,
      wuQueue: [
        { wu_id: "WU-1", wu_contract_path: "wu.md", dependencies: [] },
        { wu_id: "WU-2", wu_contract_path: "wu.md", dependencies: ["WU-1"] },
      ],
    },
  ))

// Scenario I — restart/resume.
test("Scenario I: fresh session recovers active Epic/WU/candidate/review state and continues", async () =>
  fixture(async ({ call, candidate, dispatch, review, restart }) => {
    const buildReject = buildAndReject(call, candidate, dispatch, review)
    const { candidate: a } = await buildReject("A", [finding("quote-preview")])
    await call({ action: "authorize_repair", candidate_id: a.candidate_id, dispatch_id: "repair", hypothesis: "fix", progress_evidence_ids: ["quote-preview"] })
    await dispatch("repair", "REPAIR", a.candidate_id)
    const b = await candidate("B")
    await call({ action: "record_candidate", candidate_id: b.candidate_id, dispatch_id: "repair" })

    const recovered = restart()
    assert.equal(recovered.wu.wu_id, "WU-LIVENESS")
    assert.equal(recovered.wu.current_candidate_id, b.candidate_id)
    assert.equal(recovered.wu.repair_cycle_count, 1)
    assert.equal(recovered.reviews[b.candidate_id] ?? null, null)
    assert.ok(recovered.mandate, "mandate must be recovered")

    const pass = await review(b, "PASS", "review-b", [])
    assert.equal(pass.reviews[b.candidate_id].verdict, "PASS")
  }))
