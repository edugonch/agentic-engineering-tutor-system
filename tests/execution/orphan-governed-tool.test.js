import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecutionController } from "../../src/execution/execution.js"
import { createSessionRecovery } from "../../src/execution/session-recovery.js"
import { recordKnowledgeArtifact, findApprovedDispatchAbandonment } from "../../src/project-knowledge.js"

const target = { action: "ABANDON_ORPHAN_DISPATCH", execution_id: "ALFRAN",
  wu_id: "E05-07-E", dispatch_id: "e0507-build-2", child_session_id: "ses_exact_child" }
const approval = (decision = target) => `dispatch_abandonment: ${JSON.stringify(decision)}`
async function fixture(t, decisionContent = approval(), decisionStatus = "APPROVED") {
  const root = await mkdtemp(join(tmpdir(), "orphan-governed-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const record = await recordKnowledgeArtifact(root, { artifact_type: "decision",
    artifact_id: "DECISION-E05-07-DISPATCH-ABANDON-2026-10-21", title: "Approved exact dispatch abandon",
    status: decisionStatus, owner_confirmed: true, source_refs: ["https://example.com/owner-decision"],
    content: decisionContent })
  const controller = await createExecutionController({ dir: join(root, ".harness/execution/controller/ALFRAN") })
  const commit = async (operation_type, body) => {
    const lease = await controller.acquire("ses_root")
    const snap = await controller.snapshot()
    return controller.commit({ operation_id: `fixture:${snap.state.revision}`, operation_type, body },
      { holder_session_id: "ses_root", expected_revision: snap.state.revision,
        lease_fencing_token: lease.fencing_token })
  }
  await commit("MANDATE_APPROVE", { mandate_id: "M1", total_seconds: 30000, max_wus: 1,
    authority_kind: "OWNER_APPROVED_EPIC", source_artifact_id: "EPIC", source_record_key: "sha",
    source_hash: "f".repeat(64) })
  await commit("WU_ACTIVATE", { wu_id: target.wu_id, mandate_id: "M1" })
  await commit("DISPATCH_RESERVE", { dispatch_id: target.dispatch_id, reserved_seconds: 5000 })
  await commit("DISPATCH_PREPARE", { dispatch_id: target.dispatch_id, expected_agent: "harness-builder",
    prepared_by_session_id: "ses_root", claim_required: true })
  await commit("DISPATCH_LAUNCH_CLAIM", { dispatch_id: target.dispatch_id, call_id: "call_exact" })
  await commit("DISPATCH_LAUNCH", { dispatch_id: target.dispatch_id, session_id: target.child_session_id })
  await commit("BLOCK", { class: "BLOCKED_TOOLING", reason: "Child stopped without terminal handoff" })

  const rootSession = { id: "ses_root", agent: "harness-orchestrator", projectID: "project-1" }
  const childSession = { id: target.child_session_id, agent: "harness-builder",
    parentID: "ses_root", projectID: "project-1", outcome: "interrupted" }
  const parentContext = [{ id: "msg-1", type: "assistant", content: [
    { type: "tool", id: "call_exact", name: "subagent", state: { status: "running",
      input: { agent: "harness-builder" }, metadata: { sessionID: target.child_session_id, status: "running" } } }
  ] }]
  const childContext = []
  const interrupts = []
  let waitFailure = false, failAfterFence = false
  const ctx = { session: {
    get: async ({ sessionID }) => sessionID === "ses_root" ? rootSession : childSession,
    context: async ({ sessionID }) => sessionID === "ses_root" ? parentContext : childContext,
    wait: async () => { if (waitFailure) throw new Error("still running"); return {} },
    interrupt: async params => { interrupts.push(params); if (failAfterFence && interrupts.length === 2) throw Error("interruption capability lost") },
  } }
  const input = { execution_id: target.execution_id, dispatch_id: target.dispatch_id,
    decision_artifact_id: record.artifact_id, session_id: "ses_root" }
  const recovery = createSessionRecovery(ctx, root)
  return { root, record, controller, commit, rootSession, childSession, parentContext, childContext,
    interrupts, input, recovery, setWaitFailure: v => waitFailure = v,
    setFailAfterFence: v => failAfterFence = v }
}

test("read-only authority rejects unapproved, missing, prose-only or tampered sources", async t => {
  for (const [content, status, error] of [
    [approval(), "PROPOSED", /ORPHAN_AUTHORITY_REQUIRED/],
    ["This is an approved abandonment, not a structured contract", "APPROVED", /ORPHAN_AUTHORITY_UNMAPPED/],
    ['dispatch_abandonment: {"action":"ABANDON_ORPHAN_DISPATCH","action":"NO","execution_id":"ALFRAN","wu_id":"E05-07-E","dispatch_id":"e0507-build-2","child_session_id":"ses_exact_child"}', "APPROVED", /ORPHAN_AUTHORITY_UNMAPPED/],
  ]) {
    const f = await fixture(t, content, status)
    const before = (await f.controller.snapshot()).state.revision
    await assert.rejects(f.recovery.recoverOrphan(f.input), error)
    assert.equal((await f.controller.snapshot()).state.revision, before)
  }
  const f = await fixture(t)
  const path = join(f.root, ".harness/decisions", f.record.artifact_id + ".md")
  await writeFile(path, (await readFile(path, "utf8")) + "\nmodified")
  await assert.rejects(f.recovery.recoverOrphan(f.input), /ORPHAN_AUTHORITY_INTEGRITY/)
})

test("governed orphan settlement fences exact child, charges conservative reserve once, preserves blocker", async t => {
  const f = await fixture(t)
  const source = await findApprovedDispatchAbandonment(f.root, f.record.artifact_id)
  assert.equal(source.child_session_id, target.child_session_id)
  const result = await f.recovery.recoverOrphan(f.input)
  assert.equal(result.status, "ABANDONED_RECONCILED")
  assert.equal(result.charged_seconds, 5000)
  assert.equal(result.safe_to_relaunch, true)
  assert.deepEqual(f.interrupts, [
    { sessionID: target.child_session_id, continue: false },
    { sessionID: target.child_session_id, continue: false },
  ])
  const { state, events } = await f.controller.snapshot()
  assert.equal(state.dispatches[target.dispatch_id].status, "abandoned_reconciled")
  assert.equal(state.dispatches[target.dispatch_id].reservation_status, "consumed")
  assert.equal(state.budget.reserved_seconds, 0)
  assert.equal(state.budget.used_seconds, 5000)
  assert.equal(state.blocker.class, "BLOCKED_TOOLING")
  assert.deepEqual(events.filter(e => e.operation_type.startsWith("DISPATCH_") &&
    ["DISPATCH_FENCE", "DISPATCH_ABANDON", "DISPATCH_RECONCILE_ABANDONED"].includes(e.operation_type))
    .map(e => e.operation_type), ["DISPATCH_FENCE", "DISPATCH_ABANDON", "DISPATCH_RECONCILE_ABANDONED"])
  assert.equal(state.dispatches[target.dispatch_id].fence.proof.approved_abandonment.source_hash, source.source_hash)
  const revision = state.revision
  assert.equal((await createSessionRecovery({ session: f.recovery.ctx?.session ?? {} }, f.root)
    .recoverOrphan(f.input).catch(() => ({ status: "FAILED" }))).status, "FAILED")
  // Same runtime and authority: terminal replay is read-only.
  assert.equal((await f.recovery.recoverOrphan(f.input)).status, "ALREADY_RECONCILED")
  assert.equal((await f.controller.snapshot()).state.revision, revision)
})

test("mismatched decision target or active WU cannot mutate or settle", async t => {
  const f = await fixture(t)
  const prior = (await f.controller.snapshot()).state.revision
  await assert.rejects(f.recovery.recoverOrphan({ ...f.input, dispatch_id: "another" }), /ORPHAN_AUTHORITY_MISMATCH/)
  const other = await fixture(t, approval({ ...target, child_session_id: "ses_other" }))
  const result = await other.recovery.recoverOrphan(other.input)
  assert.equal(result.status, "ORPHAN_AUTHORITY_MISMATCH")
  assert.equal((await other.controller.snapshot()).state.budget.reserved_seconds, 5000)
  assert.equal((await f.controller.snapshot()).state.revision, prior)
})

test("non-root caller, active child, unsettled tool and bad parent identity all fail closed", async t => {
  for (const change of ["nonroot", "busy", "unsettled", "wrong-parent"]) {
    const f = await fixture(t)
    if (change === "nonroot") f.rootSession.agent = "harness-builder"
    if (change === "busy") f.setWaitFailure(true)
    if (change === "unsettled") f.childContext.push({ type: "assistant", content: [{ type: "tool", state: { status: "running" } }] })
    if (change === "wrong-parent") f.childSession.parentID = "ses_other"
    const result = await f.recovery.recoverOrphan(f.input)
    assert.notEqual(result.status, "ABANDONED_RECONCILED")
    const { state, events } = await f.controller.snapshot()
    assert.equal(state.budget.reserved_seconds, 5000)
    assert.equal(events.some(e => e.operation_type === "DISPATCH_FENCE"), false)
  }
})

test("interruption after durable fence is recoverable without a second fence or charge", async t => {
  const f = await fixture(t)
  f.setFailAfterFence(true)
  const result = await f.recovery.recoverOrphan(f.input)
  assert.equal(result.status, "CAPABILITY_UNAVAILABLE")
  assert.equal((await f.controller.snapshot()).state.dispatches[target.dispatch_id].status, "launched")
  assert.ok((await f.controller.snapshot()).state.dispatches[target.dispatch_id].fence)
  f.setFailAfterFence(false)
  const retry = await f.recovery.recoverOrphan(f.input)
  assert.equal(retry.status, "ABANDONED_RECONCILED")
  const { state, events } = await f.controller.snapshot()
  assert.equal(state.budget.used_seconds, 5000)
  assert.equal(events.filter(e => e.operation_type === "DISPATCH_FENCE").length, 1)
  assert.equal(events.filter(e => e.operation_type === "DISPATCH_RECONCILE_ABANDONED").length, 1)
})
