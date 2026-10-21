import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stableHash } from "../../src/execution/serialize.js"
import { project, applyEvent } from "../../src/execution/state.js"
import { readLog, validateLog } from "../../src/execution/event-log.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { assertSessionNotOrphanFenced } from "../../src/execution/session-recovery.js"

const marker = { decision_artifact_id: "DECISION-E05-07-DISPATCH-ABANDON-2026-10-21",
  dispatch_id: "e0507-build-2", purported_approval: true }
const operation = (kind, body, index) => ({
  sequence: index + 1, event_id: `e-${index + 1}`,
  operation_id: `op-${index + 1}`, operation_type: kind,
  previous_revision: index, next_revision: index + 1,
  operation_hash: stableHash(body), body, fencing_token: 1,
  timestamp: "2026-10-21T00:00:00.000Z",
})
const steps = [
  ["MANDATE_APPROVE", { mandate_id: "M", total_seconds: 10000, max_wus: 1 }],
  ["WU_ACTIVATE", { mandate_id: "M", wu_id: "E05-07-E" }],
  ["DISPATCH_RESERVE", { dispatch_id: "e0507-build-2", reserved_seconds: 5000 }],
  ["DISPATCH_PREPARE", { dispatch_id: "e0507-build-2",
    expected_agent: "harness-builder", prepared_by_session_id: "ses_root", claim_required: true }],
  ["DISPATCH_LAUNCH_CLAIM", { dispatch_id: "e0507-build-2", call_id: "call-2" }],
  ["DISPATCH_LAUNCH", { dispatch_id: "e0507-build-2", session_id: "ses_child" }],
  ["BLOCK", { class: "BLOCKED_TOOLING", reason: "No terminal child handoff" }],
  ["BLOCKER_RECOVERY_AUTHORIZE", marker],
]
const events = ops => ops.map(([type,body],i)=>operation(type,body,i))
const snapshot = () => project(events(steps))

test("legacy marker permits durable replay without elevating it into authority or changing accounting", () => {
  const original = project(events(steps.slice(0,-1)))
  const projected = snapshot()
  assert.equal(projected.revision, 8)
  assert.equal(projected.budget.reserved_seconds, 5000)
  assert.equal(projected.budget.used_seconds, 0)
  assert.deepEqual(projected.dispatches, original.dispatches)
  assert.deepEqual(projected.blocker, original.blocker)
  assert.equal(projected.authority_resolutions, undefined)
  assert.equal(projected.last_blocker_resolution, undefined)
  assert.equal(projected.historical_recovery_markers.length, 1)
  assert.equal(projected.historical_recovery_markers[0].body_hash, stableHash(marker))
  assert.equal(projected.historical_recovery_markers[0].interpretation, "UNVERIFIED_NON_AUTHORITATIVE")
})

test("marker cannot be committed by a current runtime and a fabricated unknown type is still rejected", () => {
  const prior = project(events(steps.slice(0,-1)))
  const proposed = operation("BLOCKER_RECOVERY_AUTHORIZE", marker, prior.revision)
  assert.throws(() => applyEvent(prior, proposed), /historical replay-only/)
  assert.throws(() => project(events([...steps.slice(0,-1), ["ARBITRARY_OWNER_APPROVAL", marker]])), /Unknown operation type/)
  assert.throws(() => project(events([["BLOCKER_RECOVERY_AUTHORIZE",marker]])), /LEGACY_RECOVERY_MARKER_UNSAFE/)
})

test("journal still validates immutable hashes and revisions, never tolerates a corrupted recovery marker", () => {
  const valid = events(steps)
  assert.equal(validateLog(valid).length, steps.length)
  const tampered = structuredClone(valid)
  tampered.at(-1).body.dispatch_id = "another"
  assert.throws(() => validateLog(tampered), /Event integrity mismatch/)
  const gap = structuredClone(valid)
  gap.at(-1).previous_revision = 100
  assert.throws(() => project(gap), /State projection conflict/)
})

test("tool boundary reads a legacy marker but continues to deny a durably fenced child", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-legacy-marker-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, ".harness/execution/controller/alfran-epic05-delivery")
  await mkdir(dir, { recursive: true })
  const historical = events(steps)
  const fenceBody = { dispatch_id: "e0507-build-2", expected_revision: historical.length,
    child_session_id: "ses_child", parent_session_id: "ses_root", launch_call_id: "call-2",
    agent: "harness-builder", wu_id: "E05-07-E",
    proof: { kind: "VERIFIED_QUIESCENT_CHILD", child_session_id: "ses_child", parent_session_id: "ses_root",
      launch_call_id: "call-2", agent: "harness-builder", runtime_quiescent: true,
      pending_tools: 0, interrupted: true, fence_hook_installed: true,
      observation_hash: "a".repeat(64) } }
  const combined = [...historical, operation("DISPATCH_FENCE",fenceBody,historical.length)]
  const path = join(dir,"events.ndjson")
  await writeFile(path, combined.map(e=>JSON.stringify(e)).join("\n")+"\n")
  const rawBefore = await readFile(path,"utf8")
  assert.equal(validateLog(await readLog(path)).length, combined.length)
  const controller = await createExecutionController({ dir })
  const current = await controller.snapshot()
  assert.equal(current.state.dispatches["e0507-build-2"].fence.child_session_id,"ses_child")
  await assertSessionNotOrphanFenced(root,"ses_root")
  await assert.rejects(assertSessionNotOrphanFenced(root,"ses_child"),/ORPHAN_CHILD_FENCED/)
  assert.equal(await readFile(path,"utf8"),rawBefore)
})

test("unknown historical recovery authorization cannot substitute for indexed APPROVED dispatch abandonment", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-recovery-not-authority-"))
  t.after(() => rm(root,{recursive:true,force:true}))
  const dir = join(root,".harness/execution/controller/alfran-epic05-delivery")
  await mkdir(dir,{recursive:true})
  const path = join(dir,"events.ndjson")
  const original = events(steps).map(e=>JSON.stringify(e)).join("\n")+"\n"
  await writeFile(path,original)
  const { createSessionRecovery } = await import("../../src/execution/session-recovery.js")
  const recovery = createSessionRecovery({},root)
  await assert.rejects(recovery.recoverOrphan({
    execution_id:"alfran-epic05-delivery", dispatch_id:"e0507-build-2",
    session_id:"ses_root",decision_artifact_id:"DECISION-E05-07-DISPATCH-ABANDON-2026-10-21",
  }),/ORPHAN_AUTHORITY_REQUIRED/)
  assert.equal((await readFile(path,"utf8")),original)
})
