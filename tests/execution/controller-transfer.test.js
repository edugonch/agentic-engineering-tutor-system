import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runExecutionController, assertToolControllerAuthority } from "../../src/execution/controller-tool.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { findApprovedDecision } from "../../src/project-knowledge.js"

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-transfer-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

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

async function seedDecisionArtifact(root, { artifactId = "decision-transfer-001", sourceRefs = ["epic-001"] } = {}) {
  return recordKnowledgeArtifact(root, {
    artifact_type: "decision",
    artifact_id: artifactId,
    title: "Owner authorization for controller transfer",
    content: `Owner authorizes controller transfer for the governed execution.`,
    status: "APPROVED",
    owner_confirmed: true,
    source_refs: sourceRefs,
  })
}

async function governed(root, sid, executionId = "E1") {
  await seedEpicArtifact(root)
  await runExecutionController(root, { action: "approve_mandate", execution_id: executionId, session_id: sid, epic_artifact_id: "epic-001" })
}

function transferInput({ executionId = "E1", sessionId, decisionId = "decision-transfer-001", oldController, expectedRevision, transferId = "xfer-1", reason = "fresh session recovery" } = {}) {
  return {
    action: "transfer_controller",
    execution_id: executionId,
    session_id: sessionId,
    owner_authorization_ref: decisionId,
    expected_old_controller_session_id: oldController,
    expected_revision: expectedRevision,
    transfer_id: transferId,
    reason,
  }
}

test("valid transfer from a fresh session succeeds and updates durable controller", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.revision, 1)
    assert.equal(status.mandate.controller_session_id, oldController)

    const transfer = await runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision }))
    assert.equal(transfer.commit_status, "committed")
    assert.equal(transfer.mandate.controller_session_id, newController)
    assert.equal(transfer.revision, 2)
    assert.equal(transfer.mandate.authority_kind, "OWNER_APPROVED_EPIC")

    const after = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(after.mandate.controller_session_id, newController)
  })
})

test("transfer is idempotent with the same transfer_id and semantics", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)
    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })

    const first = await runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision, transferId: "xfer-idem" }))
    assert.equal(first.commit_status, "committed")

    const second = await runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision, transferId: "xfer-idem" }))
    assert.equal(second.commit_status, "replayed")
    assert.equal(second.mandate.controller_session_id, newController)
  })
})

test("transfer with the same transfer_id but different target conflicts", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    const otherController = "ses-other"
    await seedDecisionArtifact(root)
    await governed(root, oldController)
    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })

    await runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision, transferId: "xfer-conflict" }))
    await assert.rejects(
      runExecutionController(root, { ...transferInput({ sessionId: otherController, oldController, expectedRevision: status.revision, transferId: "xfer-conflict" }) }),
      /conflict|different content/i,
    )
  })
})

test("old controller loses mutation authority after transfer", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)
    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })

    await runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision }))
    await assert.rejects(
      runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: oldController, dispatch_id: "d1", reserved_seconds: 10 }),
      /Specialist cannot mutate execution authority/i,
    )
  })
})

test("new controller obtains mutation authority and a fresh lease after transfer", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)
    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })

    const transfer = await runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision }))
    assert.equal(transfer.fencing_token, 2) // new lease generation after expired/old lease

    const reserve = await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: newController, dispatch_id: "d1", reserved_seconds: 10 })
    assert.equal(reserve.commit_status, "committed")
  })
})

test("replay from raw events preserves transferred controller identity", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)
    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })

    await runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision }))

    const core = await createExecutionController({ dir: join(root, ".harness", "execution", "controller", "E1") })
    const recovered = await core.recover()
    assert.equal(recovered.mandate.controller_session_id, newController)
    assert.equal(recovered.revision, 2)
    assert.equal(recovered.budget.total_seconds, 100)

    const v = await runExecutionController(root, { action: "verify", execution_id: "E1" })
    assert.equal(v.passed, true)
  })
})

test("fresh session reserve before transfer is denied", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)

    await assert.rejects(
      runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: newController, dispatch_id: "d1", reserved_seconds: 10 }),
      /Specialist cannot mutate execution authority/i,
    )
  })
})

test("transfer without owner authorization is denied", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await governed(root, oldController)
    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })

    await assert.rejects(
      runExecutionController(root, { ...transferInput({ sessionId: newController, oldController, expectedRevision: status.revision }), owner_authorization_ref: "nonexistent" }),
      /No APPROVED decision artifact/i,
    )
  })
})

test("transfer with wrong expected old controller is denied", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)
    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })

    await assert.rejects(
      runExecutionController(root, transferInput({ sessionId: newController, oldController: "ses-wrong", expectedRevision: status.revision })),
      /expected old controller does not match/i,
    )
  })
})

test("transfer with stale expected revision is denied", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)

    await assert.rejects(
      runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: 0 })),
      /expected_revision|stale revision/i,
    )
  })
})

test("transfer while old controller holds a live lease is denied", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)

    // Acquire a live lease for the old controller without letting it expire.
    const core = await createExecutionController({ dir: join(root, ".harness", "execution", "controller", "E1"), lease_ttl_ms: 60000 })
    await core.acquire(oldController)

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    await assert.rejects(
      runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision })),
      /lease|fencing|held by/i,
    )
  })
})

test("transfer with a pending_launch dispatch is denied", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: oldController, dispatch_id: "d1", reserved_seconds: 10 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: oldController, dispatch_id: "d1" })

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    await assert.rejects(
      runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision })),
      /unsafe unsettled dispatch/i,
    )
  })
})

test("transfer with a launched dispatch is denied", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: oldController, dispatch_id: "d1", reserved_seconds: 10 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: oldController, dispatch_id: "d1" })
    await runExecutionController(root, { action: "record_launch", execution_id: "E1", session_id: oldController, dispatch_id: "d1", launch_session_id: "ext-1" })

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    await assert.rejects(
      runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision })),
      /unsafe unsettled dispatch/i,
    )
  })
})

test("transfer with an ambiguous dispatch is denied", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: oldController, dispatch_id: "d1", reserved_seconds: 10 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: oldController, dispatch_id: "d1" })
    await runExecutionController(root, { action: "mark_ambiguous", execution_id: "E1", session_id: oldController, dispatch_id: "d1" })

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    await assert.rejects(
      runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision })),
      /unsafe unsettled dispatch/i,
    )
  })
})

test("transfer with a finished but unreconciled dispatch is denied", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController)
    await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: oldController, dispatch_id: "d1", reserved_seconds: 10 })
    await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: oldController, dispatch_id: "d1" })
    await runExecutionController(root, { action: "record_launch", execution_id: "E1", session_id: oldController, dispatch_id: "d1", launch_session_id: "ext-1" })
    await runExecutionController(root, { action: "record_finish", execution_id: "E1", session_id: oldController, dispatch_id: "d1", result: "done" })

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    await assert.rejects(
      runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision })),
      /unsafe unsettled dispatch/i,
    )
  })
})

test("transfer after Epic completion is denied", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await governed(root, oldController, "E1")
    // Complete the Epic by activating no WUs and calling complete.
    await runExecutionController(root, { action: "complete", execution_id: "E1", session_id: oldController })

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    assert.equal(status.completed, true)
    await assert.rejects(
      runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision })),
      /already complete|execution is already complete/i,
    )
  })
})

test("transfer on a PROBE mandate is denied", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    const newController = "ses-new"
    await seedDecisionArtifact(root)
    await runExecutionController(root, { action: "init", execution_id: "E1", session_id: oldController, total_seconds: 100 })

    const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
    await assert.rejects(
      runExecutionController(root, transferInput({ sessionId: newController, oldController, expectedRevision: status.revision })),
      /OWNER_APPROVED_EPIC/i,
    )
  })
})

test("tool boundary rejects a session_id that does not match the caller", async () => {
  await withRoot(async (root) => {
    const oldController = "ses-old"
    await seedDecisionArtifact(root)
    await governed(root, oldController)

    await assert.rejects(
      assertToolControllerAuthority(root, { action: "transfer_controller", execution_id: "E1", session_id: "ses-impersonator" }),
      /Specialist cannot mutate execution authority|session identity cannot be supplied/i,
    )
  })
})

test("findApprovedDecision resolves an APPROVED decision and rejects non-approved", async () => {
  await withRoot(async (root) => {
    await seedDecisionArtifact(root, { artifactId: "approved-decision" })
    const approved = await findApprovedDecision(root, "approved-decision")
    assert.equal(approved.source_id, "approved-decision")

    await recordKnowledgeArtifact(root, {
      artifact_type: "decision",
      artifact_id: "raw-decision",
      title: "Raw decision",
      content: "Not approved.",
      status: "RAW",
      owner_confirmed: true,
      source_refs: ["approved-decision"],
    })
    await assert.rejects(findApprovedDecision(root, "raw-decision"), /No APPROVED decision artifact/)
  })
})
