import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { collectEvidence } from "../../scripts/collect-continuity-canary.mjs"

test("canary collector preserves logs, verifies session identities and never treats elapsed time as acceptance", async t => {
  const root = await mkdtemp(join(tmpdir(), "canary-collector-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, ".harness/execution/controller/E")
  const c = await createExecutionController({ dir })
  const commit = async (operation_type, body) => {
    const lease = await c.acquire("root"), { state } = await c.snapshot()
    return c.commit({ operation_type, operation_id: `test-${state.revision}`, body },
      { holder_session_id: "root", expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  await commit("MANDATE_APPROVE", { mandate_id: "M", max_wus: 1, total_seconds: 2000, authority_kind: "OWNER_APPROVED_EPIC",
    source_artifact_id: "epic", source_record_key: "record", source_hash: "hash" })
  await commit("SUPERVISOR_BIND", { session_id: "root" })
  const before = await readFile(join(dir, "events.ndjson"), "utf8")
  const client = { server: { info: async () => ({ version: "test-host" }) }, plugin: { list: async () => ({ data: [] }) },
    session: { export: async input => { assert.equal(input.sanitize, true); return { info: { id: "wrong" }, messages: [] } } } }
  const report = await collectEvidence({ projectRoot: root, executionID: "E", client })
  assert.equal(report.acceptance, "INDEPENDENT_REVIEW_REQUIRED")
  assert.equal(report.missing_sessions[0].session_id, "root")
  assert.equal(report.sessions.length, 0)
  assert.equal(report.snapshot.changed_during_collection, false)
  assert.equal(report.coverage.active_work_over_30_minutes, "NOT_PROVEN_BY_WALL_CLOCK_ALONE")
  assert.equal(await readFile(join(dir, "events.ndjson"), "utf8"), before)
})
