import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitMerge } from "../../src/execution/merge.js"
import { createExecutionController } from "../../src/execution/execution.js"

test("merge projects before acquiring its short-lived lease", async () => {
  let clock = 0
  let validUntil = null
  const calls = []
  const controller = {
    async snapshot() {
      calls.push("snapshot")
      // Reproduce >30s spent reconstructing a large event journal.
      clock += 45000
      return { state: { revision: 9 } }
    },
    async acquire(holder) {
      calls.push("acquire")
      assert.equal(holder, "session-merge")
      validUntil = clock + 30000
      return { fencing_token: 18 }
    },
    async commit(operation, options) {
      calls.push("commit")
      assert.ok(clock < validUntil, "a full projection consumed the lease before commit")
      assert.equal(options.holder_session_id, "session-merge")
      assert.equal(options.lease_fencing_token, 18)
      assert.equal(options.expected_revision, 9)
      assert.equal(operation.operation_id, "candidate:merge:start")
      assert.equal(operation.operation_type, "MERGE_START")
      return { status: "committed", revision: 10 }
    },
  }
  const result = await commitMerge(controller, "session-merge", "candidate:merge:start",
    "MERGE_START", { tree_sha: "tree" })
  assert.deepEqual(calls, ["snapshot", "acquire", "commit"])
  assert.equal(result.revision, 10)
})

test("expired and stale lease generations remain rejected after recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-lease-admission-"))
  try {
    let nowMs = 1000
    const controller = await createExecutionController({ root, now: () => nowMs, lease_ttl_ms: 50 })
    const old = await controller.acquire("holder")
    nowMs = 1100
    await assert.rejects(controller.commit({
      operation_id: "stale", operation_type: "CHECKPOINT", body: { note: "must not commit" },
    }, {
      holder_session_id: "holder", expected_revision: 0,
      lease_fencing_token: old.fencing_token,
    }), /No valid execution lease/)
    const fresh = await controller.acquire("holder")
    assert.equal(fresh.fencing_token, old.fencing_token + 1)
    await assert.rejects(controller.commit({
      operation_id: "old-token", operation_type: "CHECKPOINT", body: { note: "not authorized" },
    }, {
      holder_session_id: "holder", expected_revision: 0,
      lease_fencing_token: old.fencing_token,
    }), /Stale fencing token/)
    await assert.rejects(controller.commit({
      operation_id: "wrong-revision", operation_type: "CHECKPOINT", body: { note: "not authorized" },
    }, {
      holder_session_id: "holder", expected_revision: 42,
      lease_fencing_token: fresh.fencing_token,
    }), /Stale revision/)
    // A current lease and correct CAS still commit safely.
    const committed = await controller.commit({
      operation_id: "valid-checkpoint", operation_type: "CHECKPOINT", body: { note: "safe" },
    }, {
      holder_session_id: "holder", expected_revision: 0,
      lease_fencing_token: fresh.fencing_token,
    })
    assert.equal(committed.status, "committed")
    assert.equal(committed.revision, 1)
    assert.equal((await controller.snapshot()).state.revision, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
