import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordKnowledgeArtifact, findApprovedOrphanRecoveryPolicy } from "../../src/project-knowledge.js"
import { createExecutionSupervisor } from "../../src/execution/supervisor.js"
import { runExecutionController, claimDispatchLaunch } from "../../src/execution/controller-tool.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { createSessionRecovery } from "../../src/execution/session-recovery.js"
import { isLiteralReadOnlyGrep, isApprovedReadOnlyShellGrep, isApprovedReadOnlyShellInspection, classifyOrphanReadTools, pendingReadsNotExpanded, validOrphanPendingProof } from "../../src/execution/orphan-read-evidence.js"
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
    root, invoke, parentCall, childContext, parentContext, ctx,
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

test("interrupted no-argument pwd is a trusted inspection, but shell mutation forms are not", () => {
  const root = "/Users/poseidon/Documents/alfran/alfran-web-platform"
  for (const command of ["pwd", "cd " + root + " && pwd"]) {
    assert.equal(isApprovedReadOnlyShellInspection(command, root), true, command)
    const result = classifyOrphanReadTools([{ content: [shellPart("call_pwd", command, "shell")] }],
      { projectRoot: root })
    assert.equal(result.eligible, true)
    assert.equal(result.pending_tools, 1)
    assert.equal(result.shell_commands?.length, 1)
  }
  for (const command of [
    "pwd -P", "pwd; touch /tmp/unsafe", "pwd && touch /tmp/unsafe",
    "pwd | tee /tmp/unsafe", "pwd > /tmp/unsafe", "pwd\nrm -rf .",
    "pwd $(touch /tmp/unsafe)", "env pwd",
    "cd " + root + " && pwd && rm -rf .",
    "cd " + root + " && pwd | tee /tmp/unsafe",
    "cd " + root + "-different && pwd",
    "cd /tmp && pwd",
    "cd " + root + "/../elsewhere && pwd",
    "cd " + root + " && pwd -P",
  ]) assert.equal(isApprovedReadOnlyShellInspection(command, root), false, command)
  assert.equal(isApprovedReadOnlyShellInspection("cd " + root + " && pwd"), false)
  const before = classifyOrphanReadTools([{ content: [shellPart("call_pwd", "pwd", "shell")] }],
    { projectRoot: root })
  const changed = classifyOrphanReadTools([{ content: [shellPart("call_pwd", "pwd && touch /tmp/unsafe", "shell")] }],
    { projectRoot: root })
  assert.equal(changed.eligible, false)
  assert.equal(pendingReadsNotExpanded(before, changed), false)
})

test("owner-approved orphan with pending pwd and native read is fenced and conservatively reconciled", async t => {
  const f = await fixture(t, { pending: [
    shellPart("call_00_5fqo1sqctdoe0e4qz48sbhli", "pwd", "shell"),
    readPart("call_01_xirlv2c9ckydlg5kv6tys03x"),
  ] })
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "ABANDONED_RECONCILED")
  assert.equal(result.classification, "ABANDONED_NOT_SUCCESS")
  assert.equal(result.charged_seconds, 1800)
  assert.equal(f.interrupts(), 2)
  const {state, events} = await f.controller.snapshot()
  const d = state.dispatches[dispatch]
  assert.equal(d.status, "abandoned_reconciled")
  assert.equal(d.fence.proof.pending_tools, 2)
  assert.deepEqual(d.fence.proof.unsettled_read_only_tools, [
    "call_00_5fqo1sqctdoe0e4qz48sbhli", "call_01_xirlv2c9ckydlg5kv6tys03x",
  ])
  assert.equal(d.fence.proof.shell_commands.length, 1)
  assert.equal(d.abandonment.evidence.shell_commands.length, 1)
  assert.equal(state.budget.reserved_seconds, 0)
  assert.equal(state.budget.used_seconds, 1800)
  assert.equal(events.filter(e => e.operation_type === "DISPATCH_FENCE").length, 1)
  assert.equal(events.filter(e => e.operation_type === "DISPATCH_ABANDON").length, 1)
  assert.equal(events.filter(e => e.operation_type === "DISPATCH_RECONCILE_ABANDONED").length, 1)
  assert.equal((await f.recovery.recoverOrphan(f.call)).status, "ALREADY_RECONCILED")
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


const e0527First = root => 'cd ' + root +
  ' && grep -n "^export \\|^const CANONICAL\\|assertSchedule\\|interface ScheduleException" scheduling/src/domain/schedule.ts'
const e0527Second = root => 'cd ' + root +
  ' && grep -n "^export " scheduling/src/domain/appointment.ts scheduling/src/domain/resource-allocation.ts'

test("literal project-root cd && grep accepts the two e0527-build-4 commands without allowing arbitrary shell", () => {
  const root = "/Users/poseidon/Documents/alfran/alfran-web-platform"
  assert.equal(isApprovedReadOnlyShellGrep(e0527First(root), root), true)
  assert.equal(isApprovedReadOnlyShellGrep(e0527Second(root), root), true)
  assert.equal(isApprovedReadOnlyShellGrep(e0527First(root), root + "-other"), false)
  assert.equal(isApprovedReadOnlyShellGrep(e0527First(root), undefined), false)
  assert.equal(isApprovedReadOnlyShellGrep("grep -n pattern scheduling/src/domain/schedule.ts", root), true)
  for (const unsafe of [
    'cd ' + root + ' && grep -n "^export " scheduling/src/domain/schedule.ts && touch /tmp/unsafe',
    'cd ' + root + ' && grep -n "^export " scheduling/src/domain/schedule.ts; touch /tmp/unsafe',
    'cd ' + root + ' && grep -n "^export " scheduling/src/domain/schedule.ts | tee /tmp/unsafe',
    'cd ' + root + ' && grep -n "^export " scheduling/src/domain/schedule.ts > /tmp/unsafe',
    'cd ' + root + ' && grep -n "$(touch /tmp/unsafe)" scheduling/src/domain/schedule.ts',
    'cd ' + root + ' && grep -n "^export \`id\`" scheduling/src/domain/schedule.ts',
    'cd ' + root + ' && grep -n "^export " /etc/passwd',
    'cd ' + root + ' && grep -n "^export " ../outside.ts',
    'cd ' + root + ' && grep -n "^export " -e /tmp/unsafe',
    'cd ' + root + ' && sed -n "1,4p" scheduling/src/domain/schedule.ts',
    'cd ' + root + ' && grep -n "^export " scheduling/src/domain/schedule.ts\\nrm -rf .',
    'cd ' + root + ' && grep -n "^export " scheduling/src/domain/schedule.ts $(touch /tmp/unsafe)',
    'cd ' + root + ' && grep -n "^export " scheduling/src/domain/schedule.ts # comment',
    'cd ' + root + ' && grep -n "^export " scheduling/src/domain/schedule.ts || true',
  ]) assert.equal(isApprovedReadOnlyShellGrep(unsafe, root), false, unsafe)
  const actual = [{ content: [
    shellPart("call_00_ci2loboq5oxb1d9imf0yhp2d", e0527First(root), "shell"),
    shellPart("call_01_9duo6llr3ug72pgk6tllpovo", e0527Second(root), "shell"),
  ] }]
  const classified = classifyOrphanReadTools(actual, { projectRoot: root })
  assert.equal(classified.eligible, true)
  assert.equal(classified.pending_tools, 2)
  assert.equal(classified.shell_commands.length, 2)
  assert.equal(classifyOrphanReadTools(actual).eligible, false)
})

test("approved e0527-build-4 cd && grep orphan fences and settles without fabricating terminal results", async t => {
  const f = await fixture(t, { pending: [] })
  f.childContext[0].content = [
    shellPart("call_00_ci2loboq5oxb1d9imf0yhp2d", e0527First(f.root), "shell"),
    shellPart("call_01_9duo6llr3ug72pgk6tllpovo", e0527Second(f.root), "shell"),
  ]
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "ABANDONED_RECONCILED")
  assert.equal(result.classification, "ABANDONED_NOT_SUCCESS")
  assert.equal(result.charged_seconds, 1800)
  assert.equal(f.interrupts(), 2)
  const { state, events } = await f.controller.snapshot()
  const d = state.dispatches[dispatch]
  assert.equal(d.status, "abandoned_reconciled")
  assert.equal(d.fence.proof.pending_tools, 2)
  assert.equal(d.fence.proof.shell_commands.length, 2)
  assert.equal(d.abandonment.evidence.shell_commands.length, 2)
  assert.equal(state.budget.reserved_seconds, 0)
  assert.equal(state.budget.used_seconds, 1800)
  for (const type of ["DISPATCH_FENCE", "DISPATCH_ABANDON", "DISPATCH_RECONCILE_ABANDONED"])
    assert.equal(events.filter(event => event.operation_type === type).length, 1)
})

test("unsafe command with project-root prefix fails closed with unchanged durable reservation", async t => {
  const f = await fixture(t, { pending: [] })
  f.childContext[0].content = [
    shellPart("call_00_ci2loboq5oxb1d9imf0yhp2d", e0527First(f.root) + " && touch /tmp/unsafe", "shell"),
  ]
  const before = (await f.controller.snapshot()).state.revision
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "EVIDENCE_CONFLICT")
  assert.equal(result.diagnostic.tool_reason_code, "SHELL_COMMAND_NOT_LITERAL_GREP")
  assert.equal(result.safe_to_relaunch, false)
  assert.equal(f.interrupts(), 0)
  const { state } = await f.controller.snapshot()
  assert.equal(state.revision, before)
  assert.equal(state.dispatches[dispatch].status, "launched")
  assert.equal(state.budget.reserved_seconds, 1800)
})

test("new or changed cd && grep tools after interrupt cannot be fenced", async t => {
  const f = await fixture(t, { pending: [] })
  f.childContext[0].content = [
    shellPart("call_00_ci2loboq5oxb1d9imf0yhp2d", e0527First(f.root), "shell"),
  ]
  const original = f.ctx.session.interrupt
  f.ctx.session.interrupt = async args => {
    const result = await original(args)
    f.childContext[0].content[0].state.input.command = e0527Second(f.root)
    return result
  }
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "EVIDENCE_CONFLICT")
  assert.equal(result.diagnostic.code, "UNFINISHED_TOOL_CHANGED")
  const { state } = await f.controller.snapshot()
  assert.equal(state.dispatches[dispatch].status, "launched")
  assert.equal(state.budget.reserved_seconds, 1800)
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

test("recovery reports the exact rejected shell tool without losing the reservation", async t => {
  const f = await fixture(t, { pending: [
    shellPart("call_00_grep", "rg -n schedule scheduling/src/domain/*.ts", "shell"),
  ] })
  const before = (await f.controller.snapshot()).state.revision
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "EVIDENCE_CONFLICT")
  assert.equal(result.reason, "Orphan evidence rejected: UNSETTLED_TOOL_REJECTED")
  assert.deepEqual(result.diagnostic, {
    code: "UNSETTLED_TOOL_REJECTED",
    tool_reason_code: "SHELL_COMMAND_NOT_LITERAL_GREP",
    rejected_tool: {
      call_id: "call_00_grep", tool_name: "shell", tool_status: "running",
      input_keys: ["command"],
    },
  })
  assert.equal(f.interrupts(), 0)
  const { state } = await f.controller.snapshot()
  assert.equal(state.revision, before)
  assert.equal(state.dispatches[dispatch].status, "launched")
  assert.equal(state.budget.reserved_seconds, 1800)
})

test("recovery explains an unknown shell adapter instead of saying all pending tools must settle", async t => {
  const f = await fixture(t, { pending: [
    shellPart("call_01_grep", "grep -n schedule scheduling/src/domain/*.ts", "execute"),
  ] })
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "EVIDENCE_CONFLICT")
  assert.equal(result.diagnostic.code, "UNSETTLED_TOOL_REJECTED")
  assert.equal(result.diagnostic.tool_reason_code, "UNTRUSTED_TOOL_NAME")
  assert.equal(result.diagnostic.rejected_tool.tool_name, "execute")
  assert.equal((await f.controller.snapshot()).state.dispatches[dispatch].status, "launched")
})

test("recovery reports parent-child identity conflicts separately from tool eligibility", async t => {
  const f = await fixture(t)
  f.parentCall.state.metadata.sessionID = "ses_different_child"
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "EVIDENCE_CONFLICT")
  assert.equal(result.diagnostic.code, "STRUCTURED_CHILD_SESSION_CONFLICT")
  assert.equal((await f.controller.snapshot()).state.dispatches[dispatch].status, "launched")
})

test("recovery reports exact stage for a new pending shell command after interrupt", async t => {
  const f = await fixture(t)
  const original = f.ctx.session.interrupt
  f.ctx.session.interrupt = async args => {
    const result = await original(args)
    f.childContext[0].content.push(shellPart("changed", "cat /etc/passwd"))
    return result
  }
  const result = await f.recovery.recoverOrphan(f.call)
  assert.equal(result.status, "EVIDENCE_CONFLICT")
  assert.equal(result.diagnostic.stage, "AFTER_INTERRUPT_BEFORE_FENCE")
  assert.equal(result.diagnostic.code, "UNSETTLED_TOOL_REJECTED")
  assert.equal(result.diagnostic.tool_reason_code, "SHELL_COMMAND_NOT_LITERAL_GREP")
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

async function seedStandingPolicy(f, {
  policyId = "POLICY-BOUNDED-ORPHAN-1", maxDispatches = 1,
  maxSeconds = 1800, hoursAhead = 24,
} = {}) {
  const content = "orphan_recovery_policy: " + JSON.stringify({
    action: "RECOVER_READ_ONLY_ORPHANS", execution_id: execution,
    wu_id: wu, max_dispatches: maxDispatches,
    max_reserved_seconds: maxSeconds,
    expires_at: new Date(Date.now() + hoursAhead * 3600 * 1000).toISOString(),
  })
  return recordKnowledgeArtifact(f.root, {
    artifact_type: "decision", artifact_id: policyId,
    status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.org/orphan-owner"],
    title: "Owner-approved bounded orphan policy", content,
  })
}

test("standing policy cannot be adopted from prose, missing approval, or invalid bounds", async t => {
  const f = await fixture(t)
  await assert.rejects(findApprovedOrphanRecoveryPolicy(f.root, "unknown"), /ORPHAN_POLICY_REQUIRED/)
  await seedStandingPolicy(f, { policyId: "POLICY-EXPIRED", hoursAhead: -1 })
  await assert.rejects(findApprovedOrphanRecoveryPolicy(f.root, "POLICY-EXPIRED"), /ORPHAN_POLICY_EXPIRED/)
  await seedStandingPolicy(f, { policyId: "POLICY-TOO-WIDE", maxDispatches: 20 })
  await assert.rejects(findApprovedOrphanRecoveryPolicy(f.root, "POLICY-TOO-WIDE"), /ORPHAN_POLICY_UNMAPPED/)
  await seedStandingPolicy(f, { policyId: "POLICY-TOO-LONG", hoursAhead: 24 * 8 })
  await assert.rejects(findApprovedOrphanRecoveryPolicy(f.root, "POLICY-TOO-LONG"), /ORPHAN_POLICY_UNMAPPED/)
  await recordKnowledgeArtifact(f.root, {
    artifact_type: "decision", artifact_id: "POLICY-DUPLICATE-KEY",
    status: "APPROVED", owner_confirmed: true, title: "Invalid JSON duplicate authority",
    source_refs: ["https://example.org/orphan-owner"],
    content: 'orphan_recovery_policy: {"action":"RECOVER_READ_ONLY_ORPHANS","execution_id":"orphan-exec","wu_id":"WU-01","max_dispatches":1,"max_dispatches":2,"max_reserved_seconds":1800,"expires_at":"2026-11-08T00:00:00Z"}',
  })
  await assert.rejects(findApprovedOrphanRecoveryPolicy(f.root, "POLICY-DUPLICATE-KEY"), /ORPHAN_POLICY_UNMAPPED/)
})

test("owner standing policy recovers only one exact live child and conservatively counts its durable fence", async t => {
  const f = await fixture(t)
  await seedStandingPolicy(f)
  const policy = await findApprovedOrphanRecoveryPolicy(f.root, "POLICY-BOUNDED-ORPHAN-1")
  assert.equal(policy.max_dispatches, 1)
  const result = await f.recovery.recoverOrphan({
    ...f.call, decision_artifact_id: policy.source_artifact_id,
  })
  assert.equal(result.status, "ABANDONED_RECONCILED")
  assert.equal(result.classification, "ABANDONED_NOT_SUCCESS")
  assert.equal(result.charged_seconds, 1800)
  const { state } = await f.controller.snapshot()
  assert.equal(state.dispatches[dispatch].fence.proof.approved_abandonment.authority_kind, "BOUNDED_STANDING_POLICY")
  assert.equal(state.dispatches[dispatch].fence.proof.approved_abandonment.source_hash, policy.source_hash)
  assert.equal(state.budget.reserved_seconds, 0)
  assert.equal(state.budget.used_seconds, 1800)
  // The policy cannot authorize a second builder just because its child ID
  // was observed. The refusal is non-mutating, and reservation is retained.
  await f.invoke("reserve", { dispatch_id: "builder-2", reserved_seconds: 1800 })
  await f.invoke("prepare_launch", { dispatch_id: "builder-2", launch_agent: "harness-builder" })
  await claimDispatchLaunch(f.root, {
    execution_id: execution, dispatch_id: "builder-2", call_id: "call_two", session_id: parentID,
  })
  await f.invoke("record_launch", { dispatch_id: "builder-2", launch_session_id: "ses_child_two" })
  const before = (await f.controller.snapshot()).state.revision
  const refusal = await f.recovery.recoverOrphan({
    ...f.call, dispatch_id: "builder-2", decision_artifact_id: policy.source_record_key,
  })
  assert.equal(refusal.status, "ORPHAN_POLICY_REFUSED")
  assert.equal(refusal.reason, "BOUNDED_POLICY_LIMIT_EXHAUSTED")
  const after = (await f.controller.snapshot()).state
  assert.equal(after.revision, before)
  assert.equal(after.dispatches["builder-2"].status, "launched")
  assert.equal(after.budget.reserved_seconds, 1800)
})

test("supervisor opt-in performs one bounded governed recovery; normal supervisor leaves it untouched", async t => {
  const f = await fixture(t)
  const approval = await seedStandingPolicy(f)
  await f.invoke("block", { class: "BLOCKED_TOOLING", reason: "Exact launch call lost after compaction" })
  const prior = f.ctx.session.get
  f.ctx.session.get = async arg => {
    const response = await prior(arg)
    return arg.sessionID === parentID ? { ...response, outcome: "succeeded" } : response
  }
  let prompted = 0
  f.ctx.session.prompt = async () => { prompted++ }
  const disabled = createExecutionSupervisor(f.ctx, f.root, {
    enabled: true, orphanRecovery: f.recovery, now: () => Date.now(),
    schedule: () => ({ unref() {} }), cancel: () => {},
  })
  await disabled.bind(execution, parentID)
  await disabled.onEvent({ type: "session.execution.succeeded", data: { sessionID: parentID } })
  assert.equal((await f.controller.snapshot()).state.dispatches[dispatch].status, "launched")
  disabled.dispose()

  const enabled = createExecutionSupervisor(f.ctx, f.root, {
    enabled: true, orphanRecovery: f.recovery, orphanPolicyId: approval.artifact_id,
    schedule: () => ({ unref() {} }), cancel: () => {},
  })
  await enabled.onEvent({ type: "session.execution.succeeded", data: { sessionID: parentID } })
  const { state, events } = await f.controller.snapshot()
  assert.equal(state.dispatches[dispatch].status, "abandoned_reconciled")
  assert.equal(state.blocker.class, "BLOCKED_TOOLING")
  assert.equal(state.budget.used_seconds, 1800)
  assert.equal(events.filter(e => e.operation_type === "DISPATCH_FENCE").length, 1)
  assert.ok(prompted >= 1)
  enabled.dispose()
})

test("invalid autonomous policy produces one durable refusal and never abandons on supervisor replay", async t => {
  const f = await fixture(t)
  await f.invoke("block", { class: "BLOCKED_TOOLING", reason: "Lost child identity" })
  const previous = f.ctx.session.get
  f.ctx.session.get = async arg => {
    const result = await previous(arg)
    return arg.sessionID === parentID ? { ...result, outcome: "succeeded" } : result
  }
  f.ctx.session.prompt = async () => {}
  const supervisor = createExecutionSupervisor(f.ctx, f.root, {
    orphanRecovery: f.recovery, orphanPolicyId: "POLICY-NOT-APPROVED",
    schedule: () => ({ unref() {} }), cancel: () => {},
  })
  await supervisor.bind(execution, parentID)
  await supervisor.onEvent({ type: "session.execution.succeeded", data: { sessionID: parentID } })
  const first = await f.controller.snapshot()
  assert.equal(first.state.dispatches[dispatch].status, "launched")
  assert.equal(first.events.filter(e => e.operation_type === "ORPHAN_AUTO_TRIAGE").length, 1)
  await supervisor.onEvent({ type: "session.execution.succeeded", data: { sessionID: parentID } })
  const second = await f.controller.snapshot()
  assert.equal(second.events.filter(e => e.operation_type === "ORPHAN_AUTO_TRIAGE").length, 1)
  assert.equal(second.state.budget.reserved_seconds, 1800)
  supervisor.dispose()
})
