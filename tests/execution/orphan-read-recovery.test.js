import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { runExecutionController, claimDispatchLaunch } from "../../src/execution/controller-tool.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { createSessionRecovery } from "../../src/execution/session-recovery.js"
import { isLiteralReadOnlyGrep, classifyOrphanReadTools, pendingReadsNotExpanded, validOrphanPendingProof } from "../../src/execution/orphan-read-evidence.js"
import { seedWuContract } from "./wu-fixture.js"

const epic = "ORPHAN-EPIC", execution = "orphan-exec", wu = "WU-01", dispatch = "orphan-builder"
const childID = "ses_orphan_child", parentID = "ses_root", approvalID = "DECISION-ORPHAN-COMPACTED"
const readPart = (id, name = "read") => ({
  type: "tool", id, name,
  state: { status: "running", input: { filePath: id === "r1" ? "PROJECT_STATE.md" : "WU-01.md" }, output: "" },
})

const shellPart = (id, command, name = "bash") => ({
  type: "tool", id, name, state: { status: "running", input: { command }, output: "" },
})

async function fixture(t, { compacted = true, pending = [readPart("r1"), readPart("r2")] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "orphan-compacted-recovery-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  await recordKnowledgeArtifact(root, {
    artifact_type: "epic", artifact_id: epic, title: "Orphan test epic",
    status: "APPROVED", owner_confirmed: true, source_refs: ["https://example.org/orphan-owner"],
    content: "execution_mandate: " + JSON.stringify({
      max_wus: 1, total_seconds: 3600, merge_policy: "none", wu_sequence: [wu],
    }),
  })
  await seedWuContract(root, wu, epic, 1800)
  const invoke = (action, args = {}) => runExecutionController(root, {
    action, execution_id: execution, session_id: parentID, ...args,
  })
  await invoke("approve_mandate", { epic_artifact_id: epic })
  await invoke("activate_wu", { wu_id: wu, mandate_id: execution + "-MANDATE-001" })
  await invoke("reserve", { dispatch_id: dispatch, reserved_seconds: 1800 })
  await invoke("prepare_launch", { dispatch_id: dispatch, launch_agent: "harness-builder" })
  await claimDispatchLaunch(root, {
    execution_id: execution, dispatch_id: dispatch, call_id: "call_exact", session_id: parentID,
  })
  await invoke("record_launch", { dispatch_id: dispatch, launch_session_id: childID })
  await recordKnowledgeArtifact(root, {
    artifact_type: "decision", artifact_id: approvalID, title: "Owner approved exact orphan disposition",
    status: "APPROVED", owner_confirmed: true, source_refs: ["https://example.org/orphan-owner"],
    content: "dispatch_abandonment: " + JSON.stringify({
      action: "ABANDON_ORPHAN_DISPATCH", execution_id: execution,
      wu_id: wu, dispatch_id: dispatch, child_session_id: childID,
    }),
  })
  const parentCall = {
    id: "call_exact", name: "subagent", type: "tool",
    state: { status: "running", input: { agent: "harness-builder" },
      metadata: compacted ? {} : { sessionID: childID } },
  }
  const childContext = [{
    id: "assistant_child", type: "assistant",
    content: pending,
  }]
  const parentContext = [{ id: "assistant_parent", type: "assistant", content: [parentCall] }]
  let interrupts = 0, waits = 0
  const ctx = { session: {
    get: async ({ sessionID }) => sessionID === parentID
      ? { id: parentID, agent: "harness-orchestrator", projectID: "project-a" }
      : { id: childID, agent: "harness-builder", parentID, projectID: "project-a", outcome: null },
    context: async ({ sessionID }) => sessionID === parentID ? parentContext : childContext,
    wait: async ({ sessionID }) => { assert.equal(sessionID, childID); waits++; return { status: "idle" } },
    interrupt: async ({ sessionID, continue: keepRunning }) => {
      assert.equal(sessionID, childID); assert.equal(keepRunning, false); interrupts++
      return { interrupted: true }
    },
  }}
  return {
    root, parentCall, childContext, parentContext, ctx,
    controller: await createExecutionController({ dir: join(root, ".harness", "execution", "controller", execution) }),
    recovery: createSessionRecovery(ctx, root),
    call: { execution_id: execution, dispatch_id: dispatch, decision_artifact_id: approvalID, session_id: parentID },
    interrupts: () => interrupts, waits: () => waits,
  }
}

test("read-only unfinished entries are distinguishable from side-effecting tools", () => {
  const stale = [{ type: "assistant", content: [readPart("r1"), readPart("r2")] }]
  assert.deepEqual(classifyOrphanReadTools(stale), { eligible: true, ids: ["r1", "r2"], pending_tools: 2 })
  assert.equal(classifyOrphanReadTools([{ content: [readPart("r1", "bash")] }]).eligible, false)
  assert.equal(classifyOrphanReadTools([{ content: [readPart("r1"), readPart("r1")] }]).eligible, false)
  assert.equal(classifyOrphanReadTools([{ content: [{ type: "tool", name: "read", state: { status: "running" } }] }]).eligible, false)
  assert.equal(classifyOrphanReadTools(null).eligible, false)
  assert.equal(pendingReadsNotExpanded(classifyOrphanReadTools(stale),
    classifyOrphanReadTools([{ content: [readPart("r1")] }])), true)
  assert.equal(pendingReadsNotExpanded(classifyOrphanReadTools(stale),
    classifyOrphanReadTools([{ content: [readPart("r3")] }])), false)
  assert.equal(validOrphanPendingProof({ pending_tools: 2, interrupted_read_only: true, unsettled_read_only_tools: ["r1", "r2"] }), true)
  assert.equal(validOrphanPendingProof({ pending_tools: 2, interrupted_read_only: false, unsettled_read_only_tools: ["r1", "r2"] }), false)
  assert.equal(validOrphanPendingProof({ pending_tools: 2, interrupted_read_only: true, unsettled_read_only_tools: ["r1"] }), false)
})

test("only literal grep -n commands are classified as read-only shell work", () => {
  for (const command of [
    "grep -n 'Allocation' scheduling/src/domain/*.ts",
    'grep -n "schedule" scheduling/src/domain/*.ts',
    "grep -n pattern src/module.ts",
  ]) assert.equal(isLiteralReadOnlyGrep(command), true, command)
  for (const command of [
    "grep -n foo x.ts; touch /tmp/file",
    "grep -n foo x.ts && rm -rf /",
    "grep -n foo x.ts | tee /tmp/file",
    "grep -n foo x.ts > /tmp/file",
    'grep -n "$(touch /tmp/file)" x.ts',
    "grep -n foo x.ts\\nrm -rf /",
    "bash -lc 'grep -n foo x.ts'",
    "cat x.ts",
    "grep -Rn foo x.ts",
    "grep -n foo x.ts \\$(touch /tmp/file)",
  ]) assert.equal(isLiteralReadOnlyGrep(command), false, command)
  const good = classifyOrphanReadTools([{
    content: [shellPart("shell1", "grep -n 'schedule' scheduling/src/domain/*.ts", "shell")],
  }])
  assert.equal(good.eligible, true)
  assert.equal(good.shell_commands.length, 1)
  assert.equal(good.shell_commands[0].command_hash.length, 64)
  const changed = classifyOrphanReadTools([{
    content: [shellPart("shell1", "grep -n 'other' scheduling/src/domain/*.ts", "shell")],
  }])
  assert.equal(pendingReadsNotExpanded(good, changed), false)
  assert.equal(pendingReadsNotExpanded(good, classifyOrphanReadTools([{ content: [] }])), true)
  assert.equal(validOrphanPendingProof({
    pending_tools: 1, interrupted_read_only: true,
    unsettled_read_only_tools: ["shell1"], shell_commands: good.shell_commands,
  }), true)
})

test("owner-approved compacted orphan with pending grep shell commands is fenced and conservatively charged", async t => {
  const f = await fixture(t, {
    pending: [
      shellPart("grep1", "grep -n 'schedule' scheduling/src/domain/*.ts"),
      shellPart("grep2", "grep -n 'allocation' scheduling/src/domain/*.ts", "shell"),
    ],
  })
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "ABANDONED_RECONCILED")
  assert.equal(result.charged_seconds, 1800)
  assert.equal(f.interrupts(), 2)
  const { state, events } = await f.controller.snapshot()
  const d = state.dispatches[dispatch]
  assert.equal(d.fence.proof.pending_tools, 2)
  assert.equal(d.fence.proof.shell_commands.length, 2)
  assert.equal(d.abandonment.evidence.shell_commands.length, 2)
  assert.equal(d.status, "abandoned_reconciled")
  assert.equal(state.budget.used_seconds, 1800)
  assert.equal(state.budget.reserved_seconds, 0)
  assert.equal(events.filter(e => e.operation_type === "DISPATCH_FENCE").length, 1)
  assert.equal((await f.recovery.recoverOrphan(f.call)).status, "ALREADY_RECONCILED")
})

test("unsafe shell commands cannot be abandoned even with owner approval", async t => {
  const f = await fixture(t, { pending: [
    shellPart("sh1", "grep -n foo src/*.ts; touch /tmp/unexpected"),
  ] })
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "EVIDENCE_CONFLICT")
  assert.equal(result.safe_to_relaunch, false)
  assert.equal(f.interrupts(), 0)
  const { state } = await f.controller.snapshot()
  assert.equal(state.dispatches[dispatch].status, "launched")
  assert.equal(state.budget.reserved_seconds, 1800)
})

test("changing a running grep command after interrupt rejects the recovery", async t => {
  const f = await fixture(t, {
    pending: [shellPart("sh1", "grep -n old scheduling/*.ts")],
  })
  const original = f.ctx.session.interrupt
  f.ctx.session.interrupt = async args => {
    const result = await original(args)
    f.childContext[0].content[0].state.input.command = "grep -n updated scheduling/*.ts"
    return result
  }
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "EVIDENCE_CONFLICT")
  assert.equal((await f.controller.snapshot()).state.dispatches[dispatch].status, "launched")
})

test("approved orphan with compacted parent metadata and interrupted reads fences, charges and reconciles once", async t => {
  const f = await fixture(t)
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "ABANDONED_RECONCILED")
  assert.equal(result.classification, "ABANDONED_NOT_SUCCESS")
  assert.equal(result.charged_seconds, 1800)
  assert.equal(result.safe_to_relaunch, true)
  assert.equal(f.interrupts(), 2)
  assert.ok(f.waits() >= 3)
  const { state, events } = await f.controller.snapshot()
  const d = state.dispatches[dispatch]
  assert.equal(d.status, "abandoned_reconciled")
  assert.equal(d.fence.child_session_id, childID)
  assert.equal(d.fence.proof.identity_basis, "DURABLE_WITH_COMPACTED_PARENT")
  assert.deepEqual(d.fence.proof.unsettled_read_only_tools, ["r1", "r2"])
  assert.equal(d.abandonment.evidence.pending_tools, 2)
  assert.equal(state.budget.reserved_seconds, 0)
  assert.equal(state.budget.used_seconds, 1800)
  for (const type of ["DISPATCH_FENCE", "DISPATCH_ABANDON", "DISPATCH_RECONCILE_ABANDONED"])
    assert.equal(events.filter(event => event.operation_type === type).length, 1)
  const replay = await f.recovery.recoverOrphan(f.call)
  assert.equal(replay.status, "ALREADY_RECONCILED")
  assert.equal((await f.controller.snapshot()).events.length, events.length)
})

test("structurally recorded parent identity remains supported with no pending tools", async t => {
  const f = await fixture(t, { compacted: false, pending: [] })
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "ABANDONED_RECONCILED")
  const d = (await f.controller.snapshot()).state.dispatches[dispatch]
  assert.equal(d.fence.proof.identity_basis, "STRUCTURED_PARENT_CALL")
  assert.equal(d.fence.proof.pending_tools, 0)
})

test("unfinished writes fail without fencing, abandonment or releasing reservation", async t => {
  const f = await fixture(t, { pending: [readPart("r1"), readPart("danger", "bash")] })
  const before = (await f.controller.snapshot()).state.revision
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "EVIDENCE_CONFLICT")
  assert.equal(result.safe_to_relaunch, false)
  assert.equal(f.interrupts(), 0)
  const { state } = await f.controller.snapshot()
  assert.equal(state.revision, before)
  assert.equal(state.dispatches[dispatch].status, "launched")
  assert.equal(state.dispatches[dispatch].fence, undefined)
  assert.equal(state.budget.reserved_seconds, 1800)
})

test("contradictory structured parent identity cannot be overridden by a durable child binding", async t => {
  const f = await fixture(t)
  f.parentCall.state.metadata = { sessionID: "ses_other" }
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "EVIDENCE_CONFLICT")
  assert.equal(f.interrupts(), 0)
  assert.equal((await f.controller.snapshot()).state.dispatches[dispatch].status, "launched")
})

test("missing interrupt API or non-quiescent child cannot be recovered", async t => {
  const f = await fixture(t)
  delete f.ctx.session.interrupt
  assert.equal((await f.recovery.recoverOrphan(f.call)).status, "CAPABILITY_UNAVAILABLE")
  assert.equal((await f.controller.snapshot()).state.dispatches[dispatch].status, "launched")
})

test("post-interrupt new unfinished tools fail closed before durable fencing", async t => {
  const f = await fixture(t)
  const original = f.ctx.session.interrupt
  f.ctx.session.interrupt = async args => {
    const result = await original(args)
    f.childContext[0].content.push(readPart("new-tool"))
    return result
  }
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "EVIDENCE_CONFLICT")
  assert.equal((await f.controller.snapshot()).state.dispatches[dispatch].status, "launched")
})
