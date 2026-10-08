import { seedWuContract } from "./wu-fixture.js"
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyEvent, canStartMerge, project } from "../../src/execution/state.js"
import { stableHash } from "../../src/execution/serialize.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"

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
    operation_id: `op-next-${seq}`,
    operation_type,
    operation_hash: stableHash(body),
    body,
    previous_revision: state.revision,
    next_revision: seq,
    fencing_token: 1,
    timestamp: "t",
  }
}

function readyLegacyState() {
  const ev = makeBuilder()
  return project([
    ev("MANDATE_APPROVE", {
      execution_id: "exec",
      mandate_id: "M1",
      mandate_revision: "rev-original",
      max_wus: 40,
      total_seconds: 100,
      authority_kind: "OWNER_APPROVED_EPIC",
      source_artifact_id: "epic-original",
      source_record_key: "rk-original",
      source_hash: "hash-original",
    }),
    ev("WU_ACTIVATE", { wu_id: "WU-059", mandate_id: "M1" }),
    ev("PHASE_START", { phase: "ACTIVE", started_at: 0 }),
    ev("PHASE_END", { phase: "ACTIVE", ended_at: 30 }),
    ev("FREEZE_CANDIDATE", {
      candidate_id: "cand-1",
      manifest_hash: "manifest-1",
      tree_hash: "tree-1",
      wu_id: "WU-059",
    }),
    ev("RECORD_REVIEW", {
      candidate_id: "cand-1",
      verdict: "PASS",
      candidate_hashes: { manifest_hash: "manifest-1", tree_hash: "tree-1" },
      verification_evidence_ids: ["verify-local"],
      verified_check_ids: [],
      verification_contract_hash: null,
    }),
    ev("BIND_PR", {
      repository: "o/r",
      pr_number: 160,
      candidate_id: "cand-1",
      head_sha: "head-1",
      base_branch: "main",
      base_sha: "base-1",
    }),
    ev("RECORD_CI", {
      candidate_id: "cand-1",
      head_sha: "head-1",
      check_identity: "verify",
      conclusion: "SUCCESS",
      evidence_ref: "run-1",
    }),
    ev("BLOCK", { class: "BLOCKED_TOOLING", reason: "old mandate parser defaulted merge_policy to none" }),
  ])
}

function amendmentBody(state, overrides = {}) {
  return {
    mandate_id: state.mandate.mandate_id,
    max_wus: state.mandate.max_wus,
    total_seconds: state.budget.total_seconds,
    expected_merge_policy: "none",
    expected_required_ci_checks: [],
    merge_policy: "governed_auto",
    required_ci_checks: ["verify"],
    source_artifact_id: "epic-amendment",
    source_record_key: "rk-amendment",
    source_hash: "hash-amendment",
    source_revision: "rev-amendment",
    ...overrides,
  }
}

test("MANDATE_AMEND preserves execution/WU/budget/evidence and changes only effective merge policy", () => {
  const state = readyLegacyState()
  const preserved = {
    execution_id: state.execution_id,
    budget: structuredClone(state.budget),
    wu: structuredClone(state.wu),
    activated_wu_ids: structuredClone(state.activated_wu_ids),
    candidates: structuredClone(state.candidates),
    reviews: structuredClone(state.reviews),
    pr_binding: structuredClone(state.pr_binding),
    ci_evidence: structuredClone(state.ci_evidence),
    blocker: structuredClone(state.blocker),
  }

  const amended = applyEvent(state, nextEvent(state, "MANDATE_AMEND", amendmentBody(state)))

  assert.equal(amended.execution_id, preserved.execution_id)
  assert.deepEqual(amended.budget, preserved.budget)
  assert.deepEqual(amended.wu, preserved.wu)
  assert.deepEqual(amended.activated_wu_ids, preserved.activated_wu_ids)
  assert.deepEqual(amended.candidates, preserved.candidates)
  assert.deepEqual(amended.reviews, preserved.reviews)
  assert.deepEqual(amended.pr_binding, preserved.pr_binding)
  assert.deepEqual(amended.ci_evidence, preserved.ci_evidence)
  assert.deepEqual(amended.blocker, preserved.blocker)

  assert.equal(amended.mandate.mandate_id, "M1")
  assert.equal(amended.mandate.mandate_revision, "rev-original")
  assert.equal(amended.mandate.max_wus, 40)
  assert.equal(amended.mandate.merge_policy, "governed_auto")
  assert.deepEqual(amended.mandate.required_ci_checks, ["verify"])
  assert.equal(amended.mandate.source_artifact_id, "epic-original")
  assert.equal(amended.mandate.source_hash, "hash-original")
  assert.equal(amended.mandate.policy_revision, "rev-amendment")
  assert.equal(amended.mandate.policy_source_artifact_id, "epic-amendment")
  assert.equal(amended.mandate.policy_source_hash, "hash-amendment")
  assert.equal(amended.mandate.policy_amendment_count, 1)
  assert.equal(amended.budget.used_seconds, 30)

  const blockedGate = canStartMerge(amended)
  assert.equal(blockedGate.allowed, false)
  assert.match(blockedGate.reason, /unresolved blocker BLOCKED_TOOLING/)

  const cleared = applyEvent(amended, nextEvent(amended, "CLEAR_BLOCKER", {
    blocker_class: amended.blocker.class,
    blocked_at_revision: amended.blocker.at_revision,
    resolution: "Harness now supports versioned mandate policy amendments.",
  }))
  assert.equal(cleared.blocker, null)
  assert.equal(cleared.last_blocker_resolution.class, "BLOCKED_TOOLING")
  assert.equal(cleared.last_blocker_resolution.blocked_at_revision, amended.blocker.at_revision)
  assert.equal(canStartMerge(cleared).allowed, true)
})

test("MANDATE_AMEND rejects budget and WU-ceiling changes", () => {
  const state = readyLegacyState()
  assert.throws(
    () => applyEvent(state, nextEvent(state, "MANDATE_AMEND", amendmentBody(state, { total_seconds: 101 }))),
    /cannot change total_seconds/,
  )
  assert.throws(
    () => applyEvent(state, nextEvent(state, "MANDATE_AMEND", amendmentBody(state, { max_wus: 41 }))),
    /cannot change max_wus/,
  )
})

test("MANDATE_AMEND requires optimistic policy match and governed_auto CI coverage", () => {
  const state = readyLegacyState()
  assert.throws(
    () => applyEvent(state, nextEvent(state, "MANDATE_AMEND", amendmentBody(state, { expected_merge_policy: "human" }))),
    /expected policy does not match/,
  )
  assert.throws(
    () => applyEvent(state, nextEvent(state, "MANDATE_AMEND", amendmentBody(state, { required_ci_checks: [] }))),
    /governed_auto requires non-empty/,
  )
})

test("CLEAR_BLOCKER cannot clear terminal authority/security stops", () => {
  const ev = makeBuilder()
  const state = project([
    ev("MANDATE_APPROVE", { mandate_id: "M1", max_wus: 2, total_seconds: 100 }),
    ev("BLOCK", { class: "BLOCKED_AUTHORITY", reason: "owner authority missing" }),
  ])
  assert.throws(
    () => applyEvent(state, nextEvent(state, "CLEAR_BLOCKER", {
      blocker_class: "BLOCKED_AUTHORITY",
      blocked_at_revision: state.blocker.at_revision,
      resolution: "attempted bypass",
    })),
    /non-recoverable blocker/,
  )
})

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-amend-"))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function seedEpic(root, artifactId, executionMandate) {
  return recordKnowledgeArtifact(root, {
    artifact_type: "epic",
    artifact_id: artifactId,
    title: artifactId,
    content: `test epic\nexecution_mandate: ${JSON.stringify(executionMandate)}`,
    status: "APPROVED",
    owner_confirmed: true,
    source_refs: [`https://example.com/${artifactId}`],
  })
}

test("controller applies an approved policy-only amendment idempotently and clears only BLOCKED_TOOLING", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await seedEpic(root, "epic-original", { max_wus: 40, total_seconds: 43200 })
    await seedWuContract(root, "WU-059", "epic-original", 43200)
    await runExecutionController(root, {
      action: "approve_mandate",
      execution_id: "E1",
      session_id: sid,
      mandate_id: "EPIC03-OWNER-COMPLETION",
      epic_artifact_id: "epic-original",
    })
    await runExecutionController(root, {
      action: "activate_wu",
      execution_id: "E1",
      session_id: sid,
      wu_id: "WU-059",
      mandate_id: "EPIC03-OWNER-COMPLETION",
    })
    const blocked = await runExecutionController(root, {
      action: "block",
      execution_id: "E1",
      session_id: sid,
      class: "BLOCKED_TOOLING",
      reason: "legacy mandate policy has no supported amendment transition",
    })
    const blockedRevision = blocked.blocker.at_revision

    await seedEpic(root, "epic-policy-amendment", {
      max_wus: 40,
      total_seconds: 43200,
      merge_policy: "governed_auto",
      required_ci_checks: ["verify"],
    })

    const amended = await runExecutionController(root, {
      action: "amend_mandate",
      execution_id: "E1",
      session_id: sid,
      epic_artifact_id: "epic-policy-amendment",
    })
    assert.equal(amended.commit_status, "committed")
    assert.equal(amended.mandate.mandate_id, "EPIC03-OWNER-COMPLETION")
    assert.equal(amended.mandate.max_wus, 40)
    assert.equal(amended.budget.total_seconds, 43200)
    assert.equal(amended.budget.used_seconds, 0)
    assert.equal(amended.wu.wu_id, "WU-059")
    assert.equal(amended.mandate.merge_policy, "governed_auto")
    assert.deepEqual(amended.mandate.required_ci_checks, ["verify"])
    assert.equal(amended.blocker.class, "BLOCKED_TOOLING")
    assert.equal(amended.amendment_receipt.previous.merge_policy, "none")
    assert.equal(amended.amendment_receipt.effective.merge_policy, "governed_auto")

    const replay = await runExecutionController(root, {
      action: "amend_mandate",
      execution_id: "E1",
      session_id: sid,
      epic_artifact_id: "epic-policy-amendment",
    })
    assert.equal(replay.commit_status, "replayed")
    assert.equal(replay.revision, amended.revision)

    const cleared = await runExecutionController(root, {
      action: "clear_blocker",
      execution_id: "E1",
      session_id: sid,
      resolution: "Versioned mandate amendment support installed and verified.",
    })
    assert.equal(cleared.commit_status, "committed")
    assert.equal(cleared.blocker, null)
    assert.equal(cleared.last_blocker_resolution.class, "BLOCKED_TOOLING")
    assert.equal(cleared.last_blocker_resolution.blocked_at_revision, blockedRevision)

    const clearReplay = await runExecutionController(root, {
      action: "clear_blocker",
      execution_id: "E1",
      session_id: sid,
      resolution: "Versioned mandate amendment support installed and verified.",
    })
    assert.equal(clearReplay.commit_status, "replayed")

    const verified = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(verified.passed, true)
  })
})

test("controller refuses amendment artifacts that alter max_wus or total_seconds", async () => {
  await withRoot(async (root) => {
    const sid = "ses-1"
    await seedEpic(root, "epic-original", { max_wus: 4, total_seconds: 100 })
    await runExecutionController(root, {
      action: "approve_mandate",
      execution_id: "E1",
      session_id: sid,
      mandate_id: "M1",
      epic_artifact_id: "epic-original",
    })

    await seedEpic(root, "epic-budget-change", {
      max_wus: 4,
      total_seconds: 101,
      merge_policy: "governed_auto",
      required_ci_checks: ["verify"],
    })
    await assert.rejects(
      runExecutionController(root, {
        action: "amend_mandate",
        execution_id: "E1",
        session_id: sid,
        epic_artifact_id: "epic-budget-change",
      }),
      /refuses budget change/,
    )

    await seedEpic(root, "epic-scope-change", {
      max_wus: 5,
      total_seconds: 100,
      merge_policy: "governed_auto",
      required_ci_checks: ["verify"],
    })
    await assert.rejects(
      runExecutionController(root, {
        action: "amend_mandate",
        execution_id: "E1",
        session_id: sid,
        epic_artifact_id: "epic-scope-change",
      }),
      /refuses scope change/,
    )
  })
})
