import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { DISPATCH_STATUS, RESERVATION_STATUS } from "../../src/execution/constants.js"

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-ambiguous-resolution-"))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function seedAmbiguousWithTool(root, executionId = "E1", sid = "controller-1") {
  await runExecutionController(root, {
    action: "init",
    execution_id: executionId,
    session_id: sid,
    total_seconds: 100,
  })
  await runExecutionController(root, {
    action: "reserve",
    execution_id: executionId,
    session_id: sid,
    dispatch_id: "d1",
    reserved_seconds: 10,
  })
  await runExecutionController(root, {
    action: "prepare_launch",
    execution_id: executionId,
    session_id: sid,
    dispatch_id: "d1",
  })
  await runExecutionController(root, {
    action: "mark_ambiguous",
    execution_id: executionId,
    session_id: sid,
    dispatch_id: "d1",
  })
}

async function commitSequence(controller, holder, token, steps, startRevision = 0) {
  let revision = startRevision
  for (const [operation_id, operation_type, body] of steps) {
    const result = await controller.commit(
      { operation_id, operation_type, body },
      {
        holder_session_id: holder,
        expected_revision: revision,
        lease_fencing_token: token,
      },
    )
    revision = result.revision
  }
  return revision
}

test("resolve_ambiguous_launch binds the established session without relaunching or moving budget", async () => {
  await withRoot(async (root) => {
    await seedAmbiguousWithTool(root)

    const before = await runExecutionController(root, {
      action: "status",
      execution_id: "E1",
    })
    assert.equal(before.dispatches[0].status, DISPATCH_STATUS.AMBIGUOUS)
    assert.equal(before.dispatches[0].reservation_status, RESERVATION_STATUS.RESERVED)
    assert.equal(before.budget.reserved_seconds, 10)
    assert.equal(before.budget.used_seconds, 0)

    const resolved = await runExecutionController(root, {
      action: "resolve_ambiguous_launch",
      execution_id: "E1",
      session_id: "controller-1",
      dispatch_id: "d1",
      launch_session_id: "ses-external-1",
      resolution_evidence: "Owner investigation matched the exact existing OpenCode session.",
    })

    assert.equal(resolved.commit_status, "committed")
    assert.equal(resolved.dispatches[0].status, DISPATCH_STATUS.LAUNCHED)
    assert.equal(resolved.dispatches[0].session_id, "ses-external-1")
    assert.equal(resolved.dispatches[0].reservation_status, RESERVATION_STATUS.RESERVED)
    assert.equal(resolved.budget.reserved_seconds, 10)
    assert.equal(resolved.budget.used_seconds, 0)
    assert.equal(
      resolved.dispatches[0].ambiguity_resolution.evidence,
      "Owner investigation matched the exact existing OpenCode session.",
    )

    const controller = await createExecutionController({
      dir: join(root, ".harness", "execution", "controller", "E1"),
    })
    const snap = await controller.snapshot()
    assert.equal(
      snap.events.filter((event) => event.operation_type === "DISPATCH_LAUNCH").length,
      0,
      "recovery must not create a normal launch event or external launch side effect",
    )
    assert.equal(
      snap.events.at(-1).operation_type,
      "DISPATCH_RESOLVE_AMBIGUOUS_LAUNCH",
    )

    const recover = await runExecutionController(root, {
      action: "recover",
      execution_id: "E1",
    })
    assert.deepEqual(recover.classification.ambiguous, [])
    assert.deepEqual(recover.plan.requires_investigation, [])
    assert.deepEqual(recover.classification.running_or_launched, ["d1"])

    const restarted = await createExecutionController({
      dir: join(root, ".harness", "execution", "controller", "E1"),
    })
    assert.deepEqual((await restarted.snapshot()).state, snap.state)
  })
})

test("resolve_ambiguous_launch is idempotent and rejects conflicting session replay", async () => {
  await withRoot(async (root) => {
    await seedAmbiguousWithTool(root)

    const input = {
      action: "resolve_ambiguous_launch",
      execution_id: "E1",
      session_id: "controller-1",
      dispatch_id: "d1",
      launch_session_id: "ses-external-1",
      resolution_evidence: "Exact session recovered from the interrupted launch.",
    }

    const first = await runExecutionController(root, input)
    assert.equal(first.commit_status, "committed")
    const second = await runExecutionController(root, input)
    assert.equal(second.commit_status, "replayed")
    assert.equal(second.revision, first.revision)
    assert.equal(second.budget.reserved_seconds, 10)
    assert.equal(second.budget.used_seconds, 0)

    await assert.rejects(
      runExecutionController(root, {
        ...input,
        launch_session_id: "ses-conflicting",
      }),
      /different content|conflict/,
    )
  })
})

test("resolve_ambiguous_launch requires explicit session identity and recovery evidence", async () => {
  await withRoot(async (root) => {
    await seedAmbiguousWithTool(root)

    await assert.rejects(
      runExecutionController(root, {
        action: "resolve_ambiguous_launch",
        execution_id: "E1",
        session_id: "controller-1",
        dispatch_id: "d1",
        resolution_evidence: "known",
      }),
      /requires launch_session_id/,
    )

    await assert.rejects(
      runExecutionController(root, {
        action: "resolve_ambiguous_launch",
        execution_id: "E1",
        session_id: "controller-1",
        dispatch_id: "d1",
        launch_session_id: "ses-external-1",
      }),
      /requires resolution_evidence/,
    )
  })
})

test("resolve_ambiguous_launch rejects every non-AMBIGUOUS dispatch state", async () => {
  const cases = [
    ["reserved", async (root) => {
      await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "c", total_seconds: 100 })
      await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "c", dispatch_id: "d1", reserved_seconds: 5 })
    }],
    ["pending_launch", async (root) => {
      await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "c", total_seconds: 100 })
      await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "c", dispatch_id: "d1", reserved_seconds: 5 })
      await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: "c", dispatch_id: "d1" })
    }],
    ["launched", async (root) => {
      await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "c", total_seconds: 100 })
      await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "c", dispatch_id: "d1", reserved_seconds: 5 })
      await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: "c", dispatch_id: "d1" })
      await runExecutionController(root, { action: "record_launch", execution_id: "E1", session_id: "c", dispatch_id: "d1", launch_session_id: "ses-known" })
    }],
    ["finished", async (root) => {
      await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "c", total_seconds: 100 })
      await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "c", dispatch_id: "d1", reserved_seconds: 5 })
      await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: "c", dispatch_id: "d1" })
      await runExecutionController(root, { action: "record_launch", execution_id: "E1", session_id: "c", dispatch_id: "d1", launch_session_id: "ses-known" })
      await runExecutionController(root, { action: "record_finish", execution_id: "E1", session_id: "c", dispatch_id: "d1", result: "ok" })
    }],
    ["result_reconciled", async (root) => {
      await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "c", total_seconds: 100 })
      await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "c", dispatch_id: "d1", reserved_seconds: 5 })
      await runExecutionController(root, { action: "prepare_launch", execution_id: "E1", session_id: "c", dispatch_id: "d1" })
      await runExecutionController(root, { action: "record_launch", execution_id: "E1", session_id: "c", dispatch_id: "d1", launch_session_id: "ses-known" })
      await runExecutionController(root, { action: "record_finish", execution_id: "E1", session_id: "c", dispatch_id: "d1", result: "ok" })
      await runExecutionController(root, { action: "reconcile", execution_id: "E1", session_id: "c", dispatch_id: "d1" })
    }],
    ["released", async (root) => {
      await runExecutionController(root, { action: "init", execution_id: "E1", session_id: "c", total_seconds: 100 })
      await runExecutionController(root, { action: "reserve", execution_id: "E1", session_id: "c", dispatch_id: "d1", reserved_seconds: 5 })
      await runExecutionController(root, { action: "release", execution_id: "E1", session_id: "c", dispatch_id: "d1" })
    }],
  ]

  for (const [expectedStatus, seed] of cases) {
    await withRoot(async (root) => {
      await seed(root)
      const status = await runExecutionController(root, { action: "status", execution_id: "E1" })
      assert.equal(status.dispatches[0].status, expectedStatus)
      await assert.rejects(
        runExecutionController(root, {
          action: "resolve_ambiguous_launch",
          execution_id: "E1",
          session_id: "c",
          dispatch_id: "d1",
          launch_session_id: "ses-recovered",
          resolution_evidence: "investigated",
        }),
        /not ambiguous/,
      )
    })
  }
})

test("normal record_launch continues to reject an AMBIGUOUS dispatch", async () => {
  await withRoot(async (root) => {
    await seedAmbiguousWithTool(root)
    await assert.rejects(
      runExecutionController(root, {
        action: "record_launch",
        execution_id: "E1",
        session_id: "controller-1",
        dispatch_id: "d1",
        launch_session_id: "ses-external-1",
      }),
      /not reserved\/pending/,
    )
  })
})

test("ambiguous launch recovery remains protected by lease fencing", async () => {
  await withRoot(async (root) => {
    let clock = 0
    const controller = await createExecutionController({
      root,
      now: () => clock,
      lease_ttl_ms: 1000,
    })
    const lease1 = await controller.acquire("A")
    const revision = await commitSequence(
      controller,
      "A",
      lease1.fencing_token,
      [
        ["mandate", "MANDATE_APPROVE", { execution_id: "exec-1", mandate_id: "M1", mandate_revision: "r0", max_wus: 1, total_seconds: 100 }],
        ["reserve", "DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 10 }],
        ["prepare", "DISPATCH_PREPARE", { dispatch_id: "d1" }],
        ["ambiguous", "DISPATCH_MARK_AMBIGUOUS", { dispatch_id: "d1" }],
      ],
    )

    clock = 2000
    const lease2 = await controller.acquire("A")
    assert.notEqual(lease2.fencing_token, lease1.fencing_token)

    await assert.rejects(
      controller.commit(
        {
          operation_id: "resolve-d1",
          operation_type: "DISPATCH_RESOLVE_AMBIGUOUS_LAUNCH",
          body: {
            dispatch_id: "d1",
            session_id: "ses-external-1",
            resolution_evidence: "investigated",
          },
        },
        {
          holder_session_id: "A",
          expected_revision: revision,
          lease_fencing_token: lease1.fencing_token,
        },
      ),
      /Stale fencing token/,
    )
  })
})
