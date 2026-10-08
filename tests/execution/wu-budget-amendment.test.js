import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "wu-budget-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = (action, extra = {}) => runExecutionController(root, { execution_id: "E1", session_id: "parent", action, ...extra })
  await recordKnowledgeArtifact(root, { artifact_type: "epic", artifact_id: "EPIC03", title: "Epic", status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.com/approval"], content: 'execution_mandate: {"max_wus":10,"total_seconds":86400}' })
  await run("approve_mandate", { epic_artifact_id: "EPIC03", mandate_id: "M1" })
  await run("activate_wu", { wu_id: "WU063", mandate_id: "M1" })
  for (const [id, seconds] of [["build-1", 3600], ["build-2", 2400]]) {
    await run("reserve", { dispatch_id: id, reserved_seconds: seconds })
    await run("record_launch", { dispatch_id: id, launch_session_id: `ses_${id}` })
    await run("record_finish", { dispatch_id: id, result: "INCOMPLETE" })
    await run("reconcile", { dispatch_id: id })
  }
  const blocked = await run("block", { class: "BUDGET_EXHAUSTED", reason: "WU063 exhausted original 2400-second contract" })
  const controller = await createExecutionController({ dir: join(root, ".harness", "execution", "controller", "E1") })
  const envelope = { execution_id: "E1", mandate_id: "M1", wu_id: "WU063", blocked_at_revision: blocked.blocker.at_revision,
    expected_used_seconds: 6000, additional_seconds: 8000, epic_total_seconds: 86400 }
  const decision = (overrides = {}, metadata = {}) => recordKnowledgeArtifact(root, {
    artifact_type: "decision", artifact_id: "WU063-BUDGET-V2", title: "Owner approved additional 8000 seconds", status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.com/owner-decision"], content: `Owner approved 8000 additional seconds; history unchanged.\nwu_budget_amendment: ${JSON.stringify({ ...envelope, ...overrides })}`,
    ...metadata,
  })
  return { root, run, controller, envelope, decision }
}

test("ALFRAN regression: approved 8000 resumes blocked WU, preserving 6000 used and Epic total", async t => {
  const f = await fixture(t)
  await assert.rejects(f.run("clear_blocker", { resolution: "owner approved" }), /amend_wu_budget/)
  const authority = await f.decision()
  const before = await f.controller.snapshot()
  const result = await f.run("amend_wu_budget", { decision_artifact_id: authority.record_key })
  assert.equal(result.blocker, null)
  assert.deepEqual(result.wu_budget, { wu_id: "WU063", used_seconds: 6000, reserved_seconds: 0, ceiling_seconds: 14000, available_seconds: 8000 })
  assert.equal(result.budget.total_seconds, 86400)
  assert.equal(result.budget.available_seconds, 80400)
  const after = await f.controller.snapshot()
  assert.deepEqual(after.events.slice(0, -1), before.events)
  assert.deepEqual(after.state.dispatches, before.state.dispatches)
  assert.deepEqual(after.state.mandate, before.state.mandate)
  assert.equal(after.events.at(-1).operation_type, "WU_BUDGET_AMEND")
  const replay = await f.run("amend_wu_budget", { decision_artifact_id: authority.record_key })
  assert.equal(replay.commit_status, "replayed")
  assert.equal(replay.revision, result.revision)
  await f.run("reserve", { dispatch_id: "build-3", reserved_seconds: 5000 })
  await assert.rejects(f.run("reserve", { dispatch_id: "too-much", reserved_seconds: 3001 }), /WU_BUDGET_EXHAUSTED/)
  await f.run("prepare_launch", { dispatch_id: "build-3" })
  await f.run("record_launch", { dispatch_id: "build-3", launch_session_id: "ses_build3" })
  await f.run("record_finish", { dispatch_id: "build-3", result: "ready for review" })
  await f.run("reconcile", { dispatch_id: "build-3" })
  assert.equal((await f.run("status")).wu_budget.available_seconds, 3000)
  assert.equal((await f.run("verify")).passed, true)
})

for (const [field, value, expected] of [
  ["execution_id", "other", /execution_id mismatch/],
  ["wu_id", "WU064", /active WU/],
  ["mandate_id", "other", /mandate/],
  ["blocked_at_revision", 0, /exact active/],
  ["expected_used_seconds", 0, /stale consumed/],
  ["additional_seconds", 0, /positive/],
  ["additional_seconds", -1, /nonnegative/],
  ["additional_seconds", 1.5, /integer/],
  ["additional_seconds", 90000, /exceeds available Epic/],
  ["epic_total_seconds", 99999, /cannot change the Epic/],
]) test(`rejects invalid or stale authority ${field}=${value}`, async t => {
  const f = await fixture(t)
  const authority = await f.decision({ [field]: value })
  const before = await f.controller.snapshot()
  await assert.rejects(f.run("amend_wu_budget", { decision_artifact_id: authority.record_key }), expected)
  assert.deepEqual((await f.controller.snapshot()).state, before.state)
})

test("proposed, prose-only, duplicated and tampered decisions cannot grant budget", async t => {
  const f = await fixture(t)
  for (const [artifact_id, metadata, expected] of [
    ["proposed", { status: "PROPOSED" }, /owner-approved/],
    ["prose", { content: "8000 additional seconds approved" }, /normalize existing approval/],
    ["duplicate", { content: `wu_budget_amendment: ${JSON.stringify(f.envelope)}\nwu_budget_amendment: ${JSON.stringify(f.envelope)}` }, /exactly one/],
  ]) {
    const a = await f.decision({}, { artifact_id, ...metadata })
    await assert.rejects(f.run("amend_wu_budget", { decision_artifact_id: a.record_key }), expected)
  }
  const a = await f.decision()
  await appendFile(join(f.root, a.path), "\nmodified")
  await assert.rejects(f.run("amend_wu_budget", { decision_artifact_id: a.record_key }), /INTEGRITY/)
  assert.equal((await f.run("status")).blocker.class, "BUDGET_EXHAUSTED")
})

test("an old amendment cannot clear a later stop or be applied twice through another artifact", async t => {
  const f = await fixture(t)
  const a = await f.decision()
  await f.run("amend_wu_budget", { decision_artifact_id: a.record_key })
  const blocked = await f.run("block", { class: "BLOCKED_SECURITY", reason: "security decision required" })
  const replay = await f.run("amend_wu_budget", { decision_artifact_id: a.record_key })
  assert.equal(replay.blocker.class, "BLOCKED_SECURITY")
  const duplicate = await f.decision({}, { artifact_id: "duplicate-authority" })
  await assert.rejects(f.run("amend_wu_budget", { decision_artifact_id: duplicate.record_key }), /exact active/)
  assert.equal((await f.run("status")).revision, blocked.revision)
})

test("unsettled reservations keep recovery blocked", async t => {
  const f = await fixture(t)
  const a = await f.decision()
  await f.run("amend_wu_budget", { decision_artifact_id: a.record_key })
  await f.run("reserve", { dispatch_id: "pending", reserved_seconds: 1000 })
  const blocked = await f.run("block", { class: "BUDGET_EXHAUSTED", reason: "new budget stop" })
  const next = await f.decision({ blocked_at_revision: blocked.blocker.at_revision, additional_seconds: 9000 }, { artifact_id: "next" })
  await assert.rejects(f.run("amend_wu_budget", { decision_artifact_id: next.record_key }), /settled WU dispatches/)
})

test("billable phases count against amended WU allocation and permit debt settlement", async t => {
  const f = await fixture(t)
  const a = await f.decision()
  await f.run("amend_wu_budget", { decision_artifact_id: a.record_key })
  async function commit(type, body) {
    const lease = await f.controller.acquire("parent")
    const { state } = await f.controller.snapshot()
    return f.controller.commit({ operation_id: `phase-${state.revision}`, operation_type: type, body }, {
      holder_session_id: "parent", expected_revision: state.revision, lease_fencing_token: lease.fencing_token,
    })
  }
  await commit("PHASE_START", { phase: "ACTIVE", started_at: 0 })
  await commit("PHASE_END", { ended_at: 8001 })
  assert.equal((await f.run("status")).wu_budget.available_seconds, -1)
  await assert.rejects(f.run("reserve", { dispatch_id: "over", reserved_seconds: 1 }), /WU_BUDGET_EXHAUSTED/)
  await assert.rejects(commit("PHASE_START", { phase: "ACTIVE", started_at: 8001 }), /WU_BUDGET_EXHAUSTED/)
  assert.equal((await f.run("verify")).passed, true)
})
