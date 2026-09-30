import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { stableHash } from "../../src/execution/serialize.js"

// Operation-identity contract (v2, backward-compatible with v1 logs):
//
//   same operation_id + same operation     -> REPLAY
//   same operation_id + different operation -> CONFLICT
//
// The v1 fingerprint hashed only `body`, so a reused operation_id with a
// different operation_type (but the same body) could silently alias a replay.
// v2 hashes {operation_type, body, result}; legacy v1 events are resolved
// semantically.

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-opid-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

// A controller with an approved mandate at revision 1 and a live lease (token 1).
async function seeded(root) {
  const controller = await createExecutionController({ root })
  const lease = await controller.acquire("A")
  await controller.commit(
    { operation_id: "A:mandate", operation_type: "MANDATE_APPROVE", body: { execution_id: "A:exec", mandate_id: "M1", mandate_revision: "r0", max_wus: 4, total_seconds: 60 } },
    { holder_session_id: "A", expected_revision: 0, lease_fencing_token: lease.fencing_token },
  )
  return { controller, lease }
}

const commit = (controller, lease, operation, expected_revision) =>
  controller.commit(operation, { holder_session_id: "A", expected_revision, lease_fencing_token: lease.fencing_token })

// Rewrite one named event back to the legacy v1 format: drop the version marker
// and set operation_hash to stableHash(body) — the original v1 fingerprint.
async function downgradeToLegacyV1(root, operationId) {
  const path = join(root, ".harness", "execution", "events.ndjson")
  const events = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  for (const event of events) {
    if (event.operation_id === operationId) {
      delete event.operation_hash_version
      event.operation_hash = stableHash(event.body ?? null)
    }
  }
  await writeFile(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n")
}

test("same operation_id + same type/body/result is a replay", async () => {
  await withRoot(async (root) => {
    const { controller, lease } = await seeded(root)
    const op = { operation_id: "A:op", operation_type: "CHECKPOINT", body: { note: "x" }, result: { done: true } }
    assert.equal((await commit(controller, lease, op, 1)).status, "committed")
    const replay = await commit(controller, lease, op, 2)
    assert.equal(replay.status, "replayed")
    assert.deepEqual(replay.result, { done: true })
  })
})

test("same operation_id + different operation_type + same body is a conflict", async () => {
  await withRoot(async (root) => {
    const { controller, lease } = await seeded(root)
    await commit(controller, lease, { operation_id: "A:res", operation_type: "DISPATCH_RESERVE", body: { dispatch_id: "d1" } }, 1)
    await commit(controller, lease, { operation_id: "A:op", operation_type: "DISPATCH_PREPARE", body: { dispatch_id: "d1" } }, 2)
    await assert.rejects(
      commit(controller, lease, { operation_id: "A:op", operation_type: "DISPATCH_RELEASE", body: { dispatch_id: "d1" } }, 3),
      /reused with different content/,
    )
  })
})

test("same operation_id + same operation_type + different body is a conflict", async () => {
  await withRoot(async (root) => {
    const { controller, lease } = await seeded(root)
    await commit(controller, lease, { operation_id: "A:op", operation_type: "CHECKPOINT", body: { note: "first" } }, 1)
    await assert.rejects(
      commit(controller, lease, { operation_id: "A:op", operation_type: "CHECKPOINT", body: { note: "second" } }, 2),
      /reused with different content/,
    )
  })
})

test("same operation_id + same type/body + different result is a conflict", async () => {
  await withRoot(async (root) => {
    const { controller, lease } = await seeded(root)
    await commit(controller, lease, { operation_id: "A:op", operation_type: "CHECKPOINT", body: { note: "x" }, result: { done: true } }, 1)
    await assert.rejects(
      commit(controller, lease, { operation_id: "A:op", operation_type: "CHECKPOINT", body: { note: "x" }, result: { done: false } }, 2),
      /reused with different content/,
    )
  })
})

test("legacy v1 event with the same semantic operation is a replay", async () => {
  await withRoot(async (root) => {
    const { controller, lease } = await seeded(root)
    const op = { operation_id: "A:op", operation_type: "CHECKPOINT", body: { note: "x" }, result: null }
    await commit(controller, lease, op, 1)
    await downgradeToLegacyV1(root, "A:op")

    const restarted = await createExecutionController({ root })
    const lease2 = await restarted.acquire("A")
    const replay = await restarted.commit(op, { holder_session_id: "A", expected_revision: 2, lease_fencing_token: lease2.fencing_token })
    assert.equal(replay.status, "replayed")
  })
})

test("legacy v1 event with a different operation_type and same body is a conflict", async () => {
  await withRoot(async (root) => {
    const { controller, lease } = await seeded(root)
    await commit(controller, lease, { operation_id: "A:res", operation_type: "DISPATCH_RESERVE", body: { dispatch_id: "d1" } }, 1)
    await commit(controller, lease, { operation_id: "A:op", operation_type: "DISPATCH_PREPARE", body: { dispatch_id: "d1" } }, 2)
    await downgradeToLegacyV1(root, "A:op")

    const restarted = await createExecutionController({ root })
    const lease2 = await restarted.acquire("A")
    await assert.rejects(
      restarted.commit({ operation_id: "A:op", operation_type: "DISPATCH_RELEASE", body: { dispatch_id: "d1" } }, { holder_session_id: "A", expected_revision: 3, lease_fencing_token: lease2.fencing_token }),
      /reused with different content/,
    )
  })
})

test("new events are stamped operation_hash_version 2 with a full-identity hash", async () => {
  await withRoot(async (root) => {
    const { controller, lease } = await seeded(root)
    const res = await commit(controller, lease, { operation_id: "A:op", operation_type: "CHECKPOINT", body: { note: "x" } }, 1)
    assert.equal(res.event.operation_hash_version, 2)
    // The v2 hash is not merely the body hash; it folds in operation_type.
    assert.notEqual(res.event.operation_hash, stableHash(res.event.body))
  })
})
