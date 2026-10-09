import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { recordKnowledgeArtifact, findApprovedEpic } from "../../src/project-knowledge.js"

const deviation = "TDD ordering deviation: implementation preceded the required RED execution. No historical RED evidence exists. Retrospective validation was explicitly authorized by the owner."
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "authority-resolution-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = (action, extra = {}) => runExecutionController(root, { execution_id: "E1", session_id: "parent", action, ...extra })
  const record = input => recordKnowledgeArtifact(root, { title: "Owner decision", status: "APPROVED", owner_confirmed: true, source_refs: ["https://example.com/owner-approval"], ...input })
  await record({ artifact_type: "epic", artifact_id: "EPIC03", content: 'execution_mandate: {"max_wus":10,"total_seconds":86400}' })
  const historical = await createExecutionController({ dir: join(root, ".harness/execution/controller/E1") })
  const lease = await historical.acquire("parent")
  // Replay compatibility fixture: this mandate predates planning-estimate mode.
  const epic = await findApprovedEpic(root, "EPIC03")
  await historical.commit({ operation_id: "E1:mandate", operation_type: "MANDATE_APPROVE", body: {
    execution_id: "E1:exec", mandate_id: "M1", mandate_revision: epic.source_revision,
    max_wus: 10, total_seconds: 86400, merge_policy: "none", required_ci_checks: [],
    authority_kind: "OWNER_APPROVED_EPIC", source_artifact_id: epic.source_id,
    source_record_key: epic.record_key, source_hash: epic.sha256,
  } }, { holder_session_id: "parent", expected_revision: 0, lease_fencing_token: lease.fencing_token })
  assert.equal((await run("approve_mandate", { epic_artifact_id: "EPIC03", mandate_id: "M1" })).commit_status, "replayed")


  await historical.commit({ operation_id: "legacy-activate", operation_type: "WU_ACTIVATE", body: { wu_id: "WU063", mandate_id: "M1" } },
    { holder_session_id: "parent", expected_revision: (await historical.snapshot()).state.revision, lease_fencing_token: lease.fencing_token })
  await run("reserve", { dispatch_id: "builder", reserved_seconds: 13500 })
  await run("record_launch", { dispatch_id: "builder", launch_session_id: "ses_child" })
  await run("record_finish", { dispatch_id: "builder", result: "Partial branch; 49 passed, 3 failed; no historical RED" })
  await run("reconcile", { dispatch_id: "builder" })
  const budgetStop = await run("block", { class: "BUDGET_EXHAUSTED", reason: "Budget approval required" })
  await record({ artifact_type: "decision", artifact_id: "budget", content: `wu_budget_amendment: ${JSON.stringify({ execution_id: "E1", mandate_id: "M1", wu_id: "WU063", blocked_at_revision: budgetStop.blocker.at_revision, expected_used_seconds: 13500, additional_seconds: 500, epic_total_seconds: 86400 })}` })
  await run("amend_wu_budget", { decision_artifact_id: "budget" })
  const blocked = await run("block", { class: "BLOCKED_AUTHORITY", reason: "Implementation preceded required RED" })
  const controller = await createExecutionController({ dir: join(root, ".harness", "execution", "controller", "E1") })
  const envelope = { execution_id: "E1", mandate_id: "M1", wu_id: "WU063", blocked_at_revision: blocked.blocker.at_revision, resolution: "Owner approved retrospective validation within remaining budget; full GREEN and fresh review required" }
  const decision = (override = {}, meta = {}) => record({ artifact_type: "decision", artifact_id: "retrospective-v2", content: `${deviation}\nPreserve branch wu-063/quote-preview-issue-lineage. No budget extension. No WU064 before complete_wu. Correct all failures; baseline/mutation/regression validation; complete GREEN and fresh review, exact-head CI and governed merge required.\nauthority_resolution: ${JSON.stringify({ ...envelope, ...override })}`, ...meta })
  return { root, run, controller, envelope, decision }
}

test("approved retrospective recovery retains exactly 500 seconds and all owner conditions", async t => {
  const f = await fixture(t)
  await assert.rejects(f.run("clear_blocker", { resolution: "approved" }), /resolve_authority_blocker/)
  const a = await f.decision()
  const before = await f.controller.snapshot()
  const result = await f.run("resolve_authority_blocker", { decision_artifact_id: a.record_key })
  assert.equal(result.blocker, null)
  assert.equal(result.wu_budget.available_seconds, 500)
  assert.match(result.authority_resolutions.WU063[0].decision_content, /No historical RED evidence exists/)
  assert.match(result.authority_resolutions.WU063[0].decision_content, /Correct all failures/)
  const after = await f.controller.snapshot()
  for (const key of ["budget", "wu", "mandate", "dispatches", "candidates", "reviews", "wu_budget_amendments"]) assert.deepEqual(after.state[key], before.state[key])
  assert.deepEqual(after.events.slice(0, -1), before.events)
  const replay = await f.run("resolve_authority_blocker", { decision_artifact_id: a.record_key })
  assert.equal(replay.commit_status, "replayed")
  assert.equal(replay.revision, result.revision)
  await assert.rejects(f.run("reserve", { dispatch_id: "too-much", reserved_seconds: 501 }), /WU_BUDGET_EXHAUSTED/)
  await f.run("reserve", { dispatch_id: "retrospective", reserved_seconds: 500 })
  await assert.rejects(f.run("complete_wu", { wu_id: "WU063", candidate_id: "nonexistent" }))
  await assert.rejects(f.run("activate_wu", { wu_id: "WU064", mandate_id: "M1" }), /not complete/)
  assert.equal((await f.run("verify")).passed, true)
  assert.match((await f.run("status")).authority_resolutions.WU063[0].decision_content, /No budget extension/)
})

for (const [field, value, pattern] of [
  ["execution_id", "other", /execution_id mismatch/],
  ["mandate_id", "other", /must match/],
  ["wu_id", "WU064", /must match/],
  ["blocked_at_revision", 0, /exact active/],
  ["resolution", "", /requires resolution/],
  ["additional_seconds", 8000, /not supported/],
]) test(`rejects mismatched or unsupported authority ${field}`, async t => {
  const f = await fixture(t)
  const a = await f.decision({ [field]: value })
  const before = (await f.controller.snapshot()).state
  await assert.rejects(f.run("resolve_authority_blocker", { decision_artifact_id: a.record_key }), pattern)
  assert.deepEqual((await f.controller.snapshot()).state, before)
})

test("rejects unapproved, prose-only, duplicate-key and modified authority artifacts", async t => {
  const f = await fixture(t)
  for (const [artifact_id, metadata, expected] of [
    ["unapproved", { status: "PROPOSED" }, /owner-approved/],
    ["prose", { content: deviation }, /normalize existing approval/],
    ["duplicate", { content: `authority_resolution: ${JSON.stringify(f.envelope).replace('"blocked_at_revision":', '"blocked_at_revision":999,"blocked_at_revision":')}` }, /Duplicate/],
  ]) {
    const a = await f.decision({}, { artifact_id, ...metadata })
    await assert.rejects(f.run("resolve_authority_blocker", { decision_artifact_id: a.record_key }), expected)
  }
  const a = await f.decision()
  await appendFile(join(f.root, a.path), "changed")
  await assert.rejects(f.run("resolve_authority_blocker", { decision_artifact_id: a.record_key }), /INTEGRITY/)
})

for (const cls of ["BLOCKED_PERMISSION", "BLOCKED_SECURITY", "BLOCKED_SCOPE", "BUDGET_EXHAUSTED", "BLOCKED_AUTHORITY"]) test(`old approval cannot remove a later ${cls} stop`, async t => {
  const f = await fixture(t)
  const a = await f.decision()
  await f.run("resolve_authority_blocker", { decision_artifact_id: a.record_key })
  const blocked = await f.run("block", { class: cls, reason: "Different unresolved issue" })
  const replay = await f.run("resolve_authority_blocker", { decision_artifact_id: a.record_key })
  assert.deepEqual(replay.blocker, blocked.blocker)
  const copy = await f.decision({}, { artifact_id: "copy" })
  await assert.rejects(f.run("resolve_authority_blocker", { decision_artifact_id: copy.record_key }), /exact active/)
  if (cls !== "BLOCKED_AUTHORITY") {
    const retarget = await f.decision({ blocked_at_revision: blocked.blocker.at_revision }, { artifact_id: "retarget" })
    await assert.rejects(f.run("resolve_authority_blocker", { decision_artifact_id: retarget.record_key }), /exact active/)
  }
})
