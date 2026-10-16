import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runExecutionController } from "../../src/execution/controller-tool.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { seedWuContract } from "./wu-fixture.js"

const VERIFICATION = {
  commands: [{ id: "check-1", program: "node", args: ["-e", "process.exit(0)"] }],
  environment: { network_policy: "UNRESTRICTED" },
}

async function setup(t, { completed = 2, blockerClass = "BLOCKED_AUTHORITY" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-preactivation-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = (action, params = {}) => runExecutionController(root, {
    action, execution_id: "E1", session_id: "root", ...params,
  })
  const ctl = await createExecutionController({ dir: join(root, ".harness/execution/controller/E1") })
  const commit = async (operation_type, body) => {
    const lease = await ctl.acquire("root")
    const snap = await ctl.snapshot()
    return ctl.commit({ operation_id: `fixture:${snap.state.revision}:${operation_type}`, operation_type, body },
      { holder_session_id: "root", expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token })
  }
  await recordKnowledgeArtifact(root, {
    artifact_type: "epic", artifact_id: "EPIC-1", title: "Three frozen WUs", status: "APPROVED",
    owner_confirmed: true, source_refs: ["https://example.com/owner-epic"],
    content: `execution_mandate: ${JSON.stringify({ max_wus: 3, total_seconds: 600,
      merge_policy: "none", required_ci_checks: [],
      wu_sequence: ["WU-01", "WU-02", "WU-03"] })}`,
  })
  const baseWus = {}
  for (const wu of ["WU-01", "WU-02", "WU-03"]) {
    baseWus[wu] = await seedWuContract(root, wu, "EPIC-1", 100)
  }
  await run("approve_mandate", { epic_artifact_id: "EPIC-1" })
  for (const wu of ["WU-01", "WU-02"].slice(0, completed)) {
    await run("activate_wu", { wu_id: wu, mandate_id: "E1-MANDATE-001", wu_artifact_id: wu })
    const candidate = `cand-${wu}`
    await commit("FREEZE_CANDIDATE", { candidate_id: candidate, wu_id: wu,
      manifest_hash: `manifest-${wu}`, tree_hash: `tree-${wu}` })
    await commit("RECORD_REVIEW", { candidate_id: candidate, verdict: "PASS",
      candidate_hashes: { manifest_hash: `manifest-${wu}`, tree_hash: `tree-${wu}` },
      verification_evidence_ids: [`fixture-receipt-${wu}`], verified_check_ids: [],
      verification_contract_hash: null })
    await run("complete_wu", { candidate_id: candidate })
  }

  const approved = await recordKnowledgeArtifact(root, {
    artifact_type: "work-unit", artifact_id: "WU-03-NORMALIZED-V1",
    title: "Approved WU-03 normalized contract", status: "APPROVED",
    owner_confirmed: true, parent_refs: ["EPIC-1"],
    source_refs: ["https://example.com/approved-wu-03"],
    content: `Active-time limit: 100 seconds
Origin: WU-03 DRAFT source preserved separately
execution_contract: ${JSON.stringify({ active_seconds: 100, verification_contract: VERIFICATION, process_obligations: [] })}`,
  })
  const beforeBlock = await run("status")
  const blocked = await run("block", { class: blockerClass, reason: "WU-03 needs a selected approved contract" })
  const decision = await recordKnowledgeArtifact(root, {
    artifact_type: "decision", artifact_id: "WU-03-OWNER-RESOLUTION",
    title: "Owner approval for preactivation contract", status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.com/owner-decision"],
    content: `Retain all verification and acceptance obligations.
authority_resolution: ${JSON.stringify({ execution_id: "E1", mandate_id: "E1-MANDATE-001",
      wu_id: "WU-03", blocked_at_revision: blocked.blocker.at_revision,
      resolution: "Exact approved executable WU-03 contract is available; proceed with original scope" })}`,
  })
  return { root, run, ctl, commit, approved, blocked, decision, beforeBlock, baseWus }
}

test("preactivation recovery stages approved contract, resolves exact authority and activates frozen WU once", async t => {
  const f = await setup(t)
  const baseline = await f.ctl.snapshot()
  await assert.rejects(f.run("activate_wu", { wu_id: "WU-03", mandate_id: "E1-MANDATE-001" }), /BLOCKED_AUTHORITY/)
  await assert.rejects(f.run("bind_wu_contract", { wu_artifact_id: f.approved.record_key }), /active WU/)
  const stage = await f.run("stage_wu_contract", { wu_id: "WU-03", wu_artifact_id: f.approved.record_key,
    expected_revision: f.blocked.revision })
  assert.equal(stage.staged_wu_contract.wu_id, "WU-03")
  assert.equal(stage.staged_wu_contract.contract.source_authority, "APPROVED")
  assert.equal(stage.blocker.class, "BLOCKED_AUTHORITY")
  assert.equal(stage.budget.total_seconds, baseline.state.budget.total_seconds)
  assert.equal(stage.budget.used_seconds, baseline.state.budget.used_seconds)
  const retry = await f.run("stage_wu_contract", { wu_id: "WU-03", wu_artifact_id: f.approved.record_key,
    expected_revision: f.blocked.revision })
  assert.equal(retry.commit_status, "replayed")
  assert.equal(retry.revision, stage.revision)

  const resolution = await f.run("resolve_authority_blocker", { decision_artifact_id: f.decision.record_key })
  assert.equal(resolution.blocker, null)
  assert.equal(resolution.authority_resolutions["WU-03"][0].preactivation_contract_hash,
    stage.staged_wu_contract.contract.contract_hash)
  await assert.rejects(f.run("activate_wu", { wu_id: "WU-03", mandate_id: "E1-MANDATE-001",
    wu_artifact_id: "WU-03" }), /differs from the preactivation-staged/)
  const activated = await f.run("activate_wu", { wu_id: "WU-03", mandate_id: "E1-MANDATE-001",
    wu_artifact_id: f.approved.record_key })
  assert.equal(activated.wu.wu_id, "WU-03")
  assert.equal(activated.wu.contract.source_record_key, f.approved.record_key)
  assert.equal(activated.wu.contract.normalization_required, false)
  assert.equal(activated.budget.total_seconds, baseline.state.budget.total_seconds)
  assert.equal(activated.budget.used_seconds, baseline.state.budget.used_seconds)
  assert.equal(activated.staged_wu_contract, undefined)
  assert.equal((await f.run("verify")).passed, true)
  const log = await f.ctl.snapshot()
  assert.deepEqual(log.events.slice(0, baseline.events.length), baseline.events)
  assert.equal(log.events.filter(e => e.operation_type === "WU_CONTRACT_STAGE").length, 1)
  assert.equal(log.events.filter(e => e.operation_type === "AUTHORITY_RESOLVE").length, 1)
  assert.equal(log.events.filter(e => e.operation_type === "WU_ACTIVATE").length, 3)
})

test("staging rejects stale revision, DRAFT, non-eligible WU and unrelated blockers", async t => {
  const f = await setup(t)
  const input = { wu_id: "WU-03", wu_artifact_id: f.approved.record_key, expected_revision: f.blocked.revision }
  const baseline = (await f.ctl.snapshot()).events
  await assert.rejects(f.run("stage_wu_contract", { ...input, expected_revision: f.blocked.revision - 1 }), /stale revision/)
  await assert.rejects(f.run("stage_wu_contract", { ...input, wu_artifact_id: f.baseWus["WU-03"].record_key }), /APPROVED/)
  await assert.rejects(f.run("stage_wu_contract", { ...input, wu_id: "WU-02" }), /next frozen WU/)
  await assert.rejects(f.run("stage_wu_contract", { ...input, wu_artifact_id: "missing" }), /source/)
  assert.deepEqual((await f.ctl.snapshot()).events, baseline)
  const security = await setup(t, { blockerClass: "BLOCKED_SECURITY" })
  await assert.rejects(security.run("stage_wu_contract", { wu_id: "WU-03", wu_artifact_id: security.approved.record_key,
    expected_revision: security.blocked.revision }), /unrelated blocker/)
})

test("no stage, no preactivation AUTHORITY_RESOLVE; decision must bind exact owner blocker", async t => {
  const f = await setup(t)
  await assert.rejects(f.run("resolve_authority_blocker", { decision_artifact_id: f.decision.record_key }),
    /active WU or a preactivation-staged next WU/)
  await f.run("stage_wu_contract", { wu_id: "WU-03", wu_artifact_id: f.approved.record_key,
    expected_revision: f.blocked.revision })
  const other = await recordKnowledgeArtifact(f.root, {
    artifact_type: "decision", artifact_id: "STALE-RESOLUTION",
    title: "Stale decision", status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.com/owner-decision"], content: `authority_resolution: ${JSON.stringify({
      execution_id: "E1", mandate_id: "E1-MANDATE-001", wu_id: "WU-03",
      blocked_at_revision: 0, resolution: "No authority for this blocker",
    })}`,
  })
  await assert.rejects(f.run("resolve_authority_blocker", { decision_artifact_id: other.record_key }), /exact active/)
  assert.equal((await f.run("status")).blocker.class, "BLOCKED_AUTHORITY")
})

test("no staging while predecessor is active or at another execution's authority", async t => {
  const f = await setup(t, { completed: 1 })
  const status = await f.run("status")
  await assert.rejects(f.run("stage_wu_contract", { wu_id: "WU-03",
    wu_artifact_id: f.approved.record_key, expected_revision: status.revision }), /next frozen WU/)
  assert.equal((await f.run("status")).wu.completed, true)
})

