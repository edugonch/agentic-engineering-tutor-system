import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { runExecutionController, assertToolControllerAuthority } from "../../src/execution/controller-tool.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { freezeCandidate, captureBaseSnapshot } from "../../src/execution/candidate.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { runCandidateVerification } from "../../src/execution/verification.js"
import { verificationContractHash } from "../../src/execution/verification-contract.js"
import { createVerificationReceipt, writeVerificationReceipt } from "../../src/execution/verification-results.js"
import { sha256 } from "../../src/execution/serialize.js"

const contractText = 'WU: support the approved behavior, within payload.txt only.'
const sourceHash = sha256(contractText)
const verification = {
  source_wu_id: 'WU-P4', source_wu_hash: sourceHash,
  commands: [{ id: 'check', program: process.execPath, args: ['-e', 'process.exit(0)'] }],
}
const finding = { id: 'directory', severity: 'high', location: 'payload.txt', evidence: 'check: directory accepted', impact: 'wrong readiness', correction: 'reject directories' }
const policy = {
  version: 1, max_repair_cycles: 1, wu_id: 'WU-P4', wu_contract_path: 'wu.md', wu_contract_hash: sourceHash,
  allowed_paths: ['payload.txt'], verification_contract_hash: verificationContractHash(verification),
  build_seconds: 10, repair_seconds: 10, review_seconds: 10,
  recovery_actions: [{ id: 'restore', class: 'BLOCKED_TOOLING', actor: 'harness-builder', tool: 'read', input: { path: 'payload.txt' }, reserved_seconds: 5, success_check_id: 'check' }],
}

async function fixture(fn, { seconds = 100, overrides = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-phase4-'))
  try {
    await writeFile(join(root, 'wu.md'), contractText)
    await recordKnowledgeArtifact(root, {
      artifact_type: 'epic', artifact_id: 'epic-p4', status: 'APPROVED', owner_confirmed: true,
      title: 'Test-only Phase 4 authority', source_refs: ['wu.md'],
      content: `execution_mandate: ${JSON.stringify({ max_wus: 1, total_seconds: seconds, repair_policy: { ...policy, ...overrides } })}`,
    })
    const call = (input) => runExecutionController(root, { execution_id: 'E', session_id: 'owner', ...input })
    await call({ action: 'approve_mandate', epic_artifact_id: 'epic-p4' })
    await call({ action: 'activate_wu', wu_id: 'WU-P4', mandate_id: 'E-MANDATE-001' })
    const registry = createCandidateRegistry({ dir: join(root, '.harness/execution') })
    const candidate = async (content, paths = ['payload.txt'], vc = verification) => {
      await writeFile(join(root, 'payload.txt'), content)
      const c = await freezeCandidate(root, { paths, verification_contract: vc })
      await registry.store(c)
      return c
    }
    const receipt = async (c) => writeVerificationReceipt(join(root, '.harness/execution/verification-results'), createVerificationReceipt(await runCandidateVerification(c, 'check')))
    const dispatch = async (id, purpose, cid, result = 'done') => {
      await call({ action: 'reserve', dispatch_id: id, purpose, candidate_id: cid, reserved_seconds: purpose === 'RECOVERY' ? 5 : 10 })
      await call({ action: 'prepare_launch', dispatch_id: id })
      await call({ action: 'record_launch', dispatch_id: id, launch_session_id: `session-${id}` })
      await call({ action: 'record_finish', dispatch_id: id, result })
      await call({ action: 'reconcile', dispatch_id: id })
    }
    const review = async (c, verdict, id = `review-${c.candidate_id}`, findings = [finding]) => {
      await call({ action: 'reserve', dispatch_id: id, purpose: 'REVIEW', candidate_id: c.candidate_id, reserved_seconds: 10 })
      await call({ action: 'prepare_launch', dispatch_id: id })
      await call({ action: 'record_launch', dispatch_id: id, launch_session_id: `session-${id}` })
      const evidence = await receipt(c)
      await call({ action: 'record_finish', dispatch_id: id, result: 'review complete' })
      await call({ action: 'reconcile', dispatch_id: id })
      return call({ action: 'record_review', candidate_id: c.candidate_id, verdict, reviewer: `session-${id}`, dispatch_id: id, findings: verdict === 'PASS' ? [] : findings, verification_evidence_ids: [evidence] })
    }
    const rejectedA = async () => {
      await dispatch('build', 'BUILD')
      const a = await candidate('A')
      await call({ action: 'record_candidate', candidate_id: a.candidate_id, dispatch_id: 'build' })
      await review(a, 'CHANGES_REQUIRED', 'review-a')
      return a
    }
    const authorize = (a, extra = {}) => call({ action: 'authorize_repair', candidate_id: a.candidate_id, dispatch_id: 'repair', hypothesis: 'directory type test missing', progress_evidence_ids: ['directory'], ...extra })
    const restart = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import { runExecutionController } from ${JSON.stringify(new URL('../../src/execution/controller-tool.js', import.meta.url).href)}; console.log(JSON.stringify(await runExecutionController(${JSON.stringify(root)}, {action:'recover',execution_id:'E'})))`], { encoding: 'utf8' }))
    await fn({ root, call, candidate, receipt, dispatch, review, rejectedA, authorize, restart })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('P4 #1-4: process restarts preserve review, repair entitlement, handoff and B lineage; replay is exact', async () => fixture(async ({ call, rejectedA, authorize, dispatch, candidate, review, restart }) => {
  const a = await rejectedA()
  assert.equal(restart().reviews[a.candidate_id].findings[0].id, 'directory')
  const auth = await authorize(a)
  assert.equal(auth.wu.repair_cycle_count, 1)
  assert.equal((await authorize(a)).commit_status, 'replayed')
  await assert.rejects(authorize(a, { hypothesis: 'different' }), /conflict/)
  await dispatch('repair', 'REPAIR', a.candidate_id)
  const restored = restart()
  assert.equal(restored.wu.repair_cycle_count, 1)
  assert.equal(restored.budget.used_seconds, 30)
  const b = await candidate('B')
  await call({ action: 'record_candidate', candidate_id: b.candidate_id, dispatch_id: 'repair' })
  assert.equal(restart().wu.current_candidate_id, b.candidate_id)
  const reviewed = await review(b, 'PASS', 'review-b')
  assert.equal(reviewed.candidates[a.candidate_id].superseded_by, b.candidate_id)
  assert.equal(reviewed.candidates[b.candidate_id].supersedes, a.candidate_id)
  assert.equal(reviewed.budget.used_seconds, 40)
  assert.equal(reviewed.wu.repair_cycle_count, 1)
  assert.equal((await call({ action: 'complete_wu', candidate_id: b.candidate_id })).wu.completed, true)
}))

test('P4 #5,11: repeated failure and second repair stop durably', async () => fixture(async ({ call, rejectedA, authorize, dispatch, candidate, review }) => {
  const a = await rejectedA()
  await authorize(a)
  await dispatch('repair', 'REPAIR', a.candidate_id)
  const b = await candidate('B still fails')
  await call({ action: 'record_candidate', candidate_id: b.candidate_id, dispatch_id: 'repair' })
  const res = await review(b, 'CHANGES_REQUIRED', 'review-b')
  assert.equal(res.blocker.class, 'NO_PROGRESS')
  await assert.rejects(authorize(b, { dispatch_id: 'repair-2' }), /NO_PROGRESS|limit|blocked/i)
  assert.equal((await call({ action: 'status' })).wu.repair_cycle_count, 1)
}))

test('P4 #6: unfunded repair persists BUDGET_EXHAUSTED without resetting budget', async () => fixture(async ({ call, rejectedA, authorize }) => {
  const a = await rejectedA()
  const stopped = await authorize(a)
  assert.equal(stopped.blocker.class, 'BUDGET_EXHAUSTED')
  assert.equal(stopped.budget.used_seconds, 20)
  await assert.rejects(call({ action: 'reserve', dispatch_id: 'free', purpose: 'REPAIR', reserved_seconds: 0 }), /BUDGET_EXHAUSTED|blocked/i)
}, { seconds: 25 }))

test('P4 #7,8: review immutable; A evidence cannot accredit B; superseded A cannot close WU', async () => fixture(async ({ root, call, rejectedA, authorize, dispatch, candidate, receipt }) => {
  const a = await rejectedA()
  const evidenceA = await receipt(a)
  const core = await createExecutionController({ dir: join(root, '.harness/execution/controller/E') })
  const lease = await core.acquire('owner')
  const snap = await core.snapshot()
  await assert.rejects(core.commit({ operation_id: 'fake-fresh-pass', operation_type: 'RECORD_REVIEW', body: { ...snap.state.reviews[a.candidate_id], candidate_id: a.candidate_id, verdict: 'PASS' } }, { holder_session_id: 'owner', expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token }), /immutable|already reviewed/i)
  await authorize(a)
  await dispatch('repair', 'REPAIR', a.candidate_id)
  const b = await candidate('B')
  await call({ action: 'record_candidate', candidate_id: b.candidate_id, dispatch_id: 'repair' })
  await assert.rejects(call({ action: 'record_review', candidate_id: b.candidate_id, verdict: 'PASS', verification_evidence_ids: [evidenceA] }), /belongs to/)
  await assert.rejects(call({ action: 'complete_wu', candidate_id: a.candidate_id }), /current|superseded/)
}))

test('P4 #9: all terminal blockers are sticky across operations and execution-ID churn', async () => {
  for (const cls of ['BLOCKED_PERMISSION', 'BLOCKED_AUTHORITY', 'BLOCKED_SECURITY', 'BLOCKED_SCOPE', 'NO_PROGRESS', 'BUDGET_EXHAUSTED']) {
    await fixture(async ({ call, rejectedA, authorize }) => {
      const a = await rejectedA()
      await call({ action: 'block', blocker_id: 'hard', class: cls, reason: 'stop', failure_signature: 'denied-action' })
      await assert.rejects(authorize(a), /blocked|terminal/i)
      await assert.rejects(call({ action: 'block', blocker_id: 'soft', class: 'BLOCKED_TOOLING' }), /terminal|blocked/i)
      await assert.rejects(call({ action: 'complete_wu', candidate_id: a.candidate_id }), /terminal|blocked/i)
      await assert.rejects(call({ action: 'approve_mandate', execution_id: 'escape', epic_artifact_id: 'epic-p4' }), /bound|ownership/i)
      assert.equal((await call({ action: 'status' })).blocker.class, cls)
    })
  }
})

test('P4 #10: one authorized recovery resumes same attempt after restart, resolves with real receipt, cannot replenish attempts', async () => fixture(async ({ root, call, rejectedA, receipt, dispatch, restart }) => {
  const a = await rejectedA()
  await call({ action: 'block', blocker_id: 'tool', class: 'BLOCKED_TOOLING', reason: 'transient', failure_signature: 'tool:resource' })
  const input = { action: 'authorize_recovery', blocker_id: 'tool', recovery_action_id: 'restore', dispatch_id: 'recovery', hypothesis: 'restore resource', progress_evidence_ids: ['tool'] }
  const auth = await call(input)
  assert.equal(auth.wu.recovery_attempts.BLOCKED_TOOLING, 1)
  assert.equal(restart().wu.recovery_attempts.BLOCKED_TOOLING, 1)
  assert.equal((await call(input)).commit_status, 'replayed')
  await assert.rejects(call({ ...input, dispatch_id: 'other' }), /conflict|attempt|already/)
  await call({ action: 'reserve', dispatch_id: 'recovery', purpose: 'RECOVERY', candidate_id: a.candidate_id, reserved_seconds: 5 })
  await call({ action: 'prepare_launch', dispatch_id: 'recovery' })
  await call({ action: 'record_launch', dispatch_id: 'recovery', launch_session_id: 'session-recovery' })
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
  await guard.beforeTool({ sessionID: 'session-recovery', tool: 'read', input: { path: 'payload.txt' }, id: 'tool-call-restore' })
  await guard.afterTool({ sessionID: 'session-recovery', tool: 'read', input: { path: 'payload.txt' }, status: 'completed', result: { content: 'resource restored' }, id: 'tool-call-restore' })
  const evidence = await receipt(a)
  await call({ action: 'record_finish', dispatch_id: 'recovery', result: 'restored' })
  await call({ action: 'reconcile', dispatch_id: 'recovery' })
  const done = await call({ action: 'resolve_blocker', blocker_id: 'tool', verification_evidence_ids: [evidence] })
  assert.equal(done.blocker, null)
  await call({ action: 'block', blocker_id: 'tool2', class: 'BLOCKED_TOOLING', failure_signature: 'other-resource' })
  const stopped = await call({ ...input, blocker_id: 'tool2', dispatch_id: 'again' })
  assert.equal(stopped.blocker.class, 'NO_PROGRESS')
}))

test('P4 #12: stale fencing cannot authorize repair', async () => fixture(async ({ root, rejectedA }) => {
  const a = await rejectedA()
  let now = 1000
  const core = await createExecutionController({ dir: join(root, '.harness/execution/controller/E'), now: () => now })
  // Existing real lease must expire before controlled-clock acquisition.
  now = Date.now() + 100000
  const old = await core.acquire('old')
  now += 100000
  await core.acquire('new')
  const snap = await core.snapshot()
  await assert.rejects(core.commit({ operation_id: 'stale-repair', operation_type: 'REPAIR_AUTHORIZE', body: { candidate_id: a.candidate_id } }, { holder_session_id: 'old', expected_revision: snap.state.revision, lease_fencing_token: old.fencing_token }), /Fencing|fencing/)
}))

test('P4 scope, verification contract and unchanged tree cannot be laundered through repair', async () => fixture(async ({ root, call, rejectedA, authorize, dispatch, candidate }) => {
  const a = await rejectedA()
  await authorize(a)
  await dispatch('repair', 'REPAIR', a.candidate_id)
  await writeFile(join(root, 'outside.txt'), 'scope expansion')
  const outside = await candidate('B', ['payload.txt', 'outside.txt'])
  await assert.rejects(call({ action: 'record_candidate', candidate_id: outside.candidate_id, dispatch_id: 'repair' }), /scope/i)
  const changedContract = await candidate('B', ['payload.txt'], { ...verification, commands: [{ id: 'weakened', program: process.execPath, args: ['-e', ''] }] })
  await assert.rejects(call({ action: 'record_candidate', candidate_id: changedContract.candidate_id, dispatch_id: 'repair' }), /contract/i)
}))

test('P4 policy is explicit, bounded and cannot be overridden or reset through another controller', async () => fixture(async ({ call }) => {
  const s = await call({ action: 'status' })
  assert.equal(s.mandate.repair_policy.max_repair_cycles, 1)
  await assert.rejects(call({ action: 'approve_mandate', execution_id: 'different', epic_artifact_id: 'epic-p4', total_seconds: 9999 }), /ownership|bound/i)
  assert.equal((await call({ action: 'status' })).budget.total_seconds, 100)
}))

test('P4 #13: permission rejection in descendant persists, blocks alternate tools/sessions/controllers after restart', async () => fixture(async ({ root, call, rejectedA, restart }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  await rejectedA()
  const ctx = { session: { get: async ({ sessionID }) => ({ id: sessionID, parentID: sessionID === 'child' ? 'owner' : undefined }) } }
  const guard = createExecutionGuard(root, ctx)
  await guard.onPermission({ sessionID: 'child', effect: 'deny', action: 'shell', resources: ['denied'] })
  assert.equal(restart().blocker.class, 'BLOCKED_PERMISSION')
  const fresh = createExecutionGuard(root, ctx)
  for (const tool of ['shell', 'webfetch', 'subagent', 'harness_freeze_candidate']) {
    await assert.rejects(fresh.beforeTool({ sessionID: 'child', tool, input: {} }), /BLOCKED_PERMISSION/)
  }
  await assert.rejects(fresh.beforeTool({ sessionID: 'owner', tool: 'harness_execution_controller', input: { action: 'approve_mandate', execution_id: 'escape' } }), /BLOCKED_PERMISSION/)
  await assert.rejects(call({ action: 'approve_mandate', execution_id: 'escape', session_id: 'different', epic_artifact_id: 'epic-p4' }), /ownership|bound/)
  await fresh.beforeTool({ sessionID: 'owner', tool: 'harness_execution_controller', input: { action: 'status', execution_id: 'E' } })
}))

test('P4 runtime verification and recovery tools require bound live reservations, exact approved action', async () => fixture(async ({ root, call, rejectedA }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const a = await rejectedA()
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
  await assert.rejects(guard.beforeTool({ sessionID: 'session-review-a', tool: 'harness_run_verification', input: { candidate_id: a.candidate_id, verification_check_id: 'check' } }), /reservation|dispatch|settled/i)
  await call({ action: 'block', blocker_id: 't', class: 'BLOCKED_TOOLING', failure_signature: 'tool resource' })
  await call({ action: 'authorize_recovery', blocker_id: 't', recovery_action_id: 'restore', dispatch_id: 'r', hypothesis: 'restore', progress_evidence_ids: ['t'] })
  await call({ action: 'reserve', purpose: 'RECOVERY', dispatch_id: 'r', candidate_id: a.candidate_id, reserved_seconds: 5 })
  await call({ action: 'prepare_launch', dispatch_id: 'r' })
  await call({ action: 'record_launch', dispatch_id: 'r', launch_session_id: 'recovery-session' })
  await assert.rejects(guard.beforeTool({ sessionID: 'recovery-session', agent: 'harness-builder', tool: 'shell', input: { command: 'chmod +x whatever' } }), /approved|recovery/i)
  await guard.beforeTool({ sessionID: 'recovery-session', agent: 'harness-builder', tool: 'read', input: { path: 'payload.txt' }, id: 'restore-once' })
}))

test('P4 distinct findings still cannot authorize repair #2; zero reservation and duplicate semantic dispatch rejected', async () => fixture(async ({ call, rejectedA, authorize, dispatch, candidate, review }) => {
  const a = await rejectedA()
  await authorize(a)
  await assert.rejects(call({ action: 'reserve', purpose: 'REPAIR', candidate_id: a.candidate_id, dispatch_id: 'repair', reserved_seconds: 0 }), /positive/)
  await dispatch('repair', 'REPAIR', a.candidate_id)
  await assert.rejects(call({ action: 'reserve', purpose: 'REPAIR', candidate_id: a.candidate_id, dispatch_id: 'duplicate', reserved_seconds: 10 }), /bound/)
  const b = await candidate('B')
  await call({ action: 'record_candidate', candidate_id: b.candidate_id, dispatch_id: 'repair' })
  await review(b, 'CHANGES_REQUIRED', 'review-b', [{ ...finding, id: 'other' }])
  const stop = await authorize(b, { dispatch_id: 'second', progress_evidence_ids: ['other'] })
  assert.equal(stop.blocker.reason, 'REPAIR_LIMIT_REACHED')
  assert.equal(stop.wu.repair_cycle_count, 1)
}))

test('P4 raw core rejects mandate replacement, unknown recovery action and missing resolution evidence', async () => fixture(async ({ root, call, rejectedA }) => {
  await rejectedA()
  await call({ action: 'block', blocker_id: 't', class: 'BLOCKED_TOOLING', failure_signature: 'tool resource' })
  await assert.rejects(call({ action: 'authorize_recovery', blocker_id: 't', recovery_action_id: 'not-approved', dispatch_id: 'r' }), /No approved/)
  await assert.rejects(call({ action: 'resolve_blocker', blocker_id: 't', verification_evidence_ids: [] }), /settled/)
  const core = await createExecutionController({ dir: join(root, '.harness/execution/controller/E') })
  const lease = await core.acquire('owner')
  const snap = await core.snapshot()
  await assert.rejects(core.commit({ operation_id: 'top-up', operation_type: 'MANDATE_APPROVE', body: { mandate_id: 'new', max_wus: 1, total_seconds: 9000 } }, { holder_session_id: 'owner', expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token }), /replaced|topped/)
}))

test('P4 runtime child launch binds one prepared dispatch before work; alternate launch cannot duplicate it', async () => fixture(async ({ root, call }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const ctx = { session: { get: async ({ sessionID }) => ({ parentID: sessionID.startsWith('child') ? 'owner' : undefined }) } }
  const guard = createExecutionGuard(root, ctx)
  await assert.rejects(guard.beforeTool({ sessionID: 'child-unauthorized', agent: 'harness-builder', tool: 'shell', input: {} }), /dispatch|authorization/)
  await call({ action: 'reserve', dispatch_id: 'build', purpose: 'BUILD', reserved_seconds: 10 })
  await call({ action: 'prepare_launch', dispatch_id: 'build' })
  await guard.beforeTool({ sessionID: 'owner', tool: 'subagent', id: 'call-1', input: { agent: 'harness-builder', prompt: 'build exact WU' } })
  await assert.rejects(guard.beforeTool({ sessionID: 'owner', tool: 'subagent', id: 'call-2', input: { agent: 'harness-builder' } }), /launch|dispatch|claimed/)
  await guard.beforeTool({ sessionID: 'child-build', agent: 'harness-builder', tool: 'read', input: { path: 'payload.txt' } })
  const s = await call({ action: 'status' })
  assert.equal(s.dispatches[0].session_id, 'child-build')
  assert.equal(s.dispatches[0].status, 'launched')
  await assert.rejects(guard.beforeTool({ sessionID: 'child-other', agent: 'harness-builder', tool: 'shell', input: {} }), /dispatch|authorization/)
}))

test('P4 held reservation can launch at zero unreserved availability; recovery cannot resolve without action evidence', async () => fixture(async ({ call, rejectedA, receipt }) => {
  const a = await rejectedA()
  await call({ action: 'block', blocker_id: 'tool', class: 'BLOCKED_TOOLING', failure_signature: 'transient' })
  await call({ action: 'authorize_recovery', blocker_id: 'tool', recovery_action_id: 'restore', dispatch_id: 'rec', hypothesis: 'restore', progress_evidence_ids: ['tool'] })
  const reserved = await call({ action: 'reserve', dispatch_id: 'rec', purpose: 'RECOVERY', candidate_id: a.candidate_id, reserved_seconds: 5 })
  assert.equal(reserved.budget.available_seconds, 0)
  await call({ action: 'prepare_launch', dispatch_id: 'rec' })
  await call({ action: 'record_launch', dispatch_id: 'rec', launch_session_id: 'rec-session' })
  const id = await receipt(a)
  await call({ action: 'record_finish', dispatch_id: 'rec', result: 'asserted success only' })
  await call({ action: 'reconcile', dispatch_id: 'rec' })
  await assert.rejects(call({ action: 'resolve_blocker', blocker_id: 'tool', verification_evidence_ids: [id] }), /action evidence/)
}, { seconds: 25 }))

test('P4 initial candidate cannot smuggle out-of-scope content via base snapshot', async () => fixture(async ({ root, call, dispatch }) => {
  await dispatch('build', 'BUILD')
  await writeFile(join(root, 'outside.txt'), 'smuggled base change')
  const base = await captureBaseSnapshot(root, ['outside.txt'])
  const c = await freezeCandidate(root, { base, paths: [], verification_contract: verification })
  await createCandidateRegistry({ dir: join(root, '.harness/execution') }).store(c)
  await assert.rejects(call({ action: 'record_candidate', candidate_id: c.candidate_id, dispatch_id: 'build' }), /scope/)
}))

test('P4 launch claim survives restart as ambiguous and cannot release its reservation', async () => fixture(async ({ root, call, restart }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
  await call({ action: 'reserve', dispatch_id: 'build', purpose: 'BUILD', reserved_seconds: 10 })
  await call({ action: 'prepare_launch', dispatch_id: 'build' })
  await guard.beforeTool({ sessionID: 'owner', tool: 'subagent', id: 'launch-claim', input: { agent: 'harness-builder' } })
  assert.deepEqual(restart().classification.ambiguous, ['build'])
  await assert.rejects(call({ action: 'release', dispatch_id: 'build' }), /ambiguous|claimed/i)
  assert.equal((await call({ action: 'status' })).budget.reserved_seconds, 10)
}))

test('P4 #13 lease conflict: permission denial remains durable before BLOCK append and reconciles exactly once', async () => fixture(async ({ root, call, restart }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const core = await createExecutionController({ dir: join(root, '.harness/execution/controller/E'), now: () => Date.now() + 100000 })
  await core.acquire('replacement-owner')
  const event = { sessionID: 'owner', effect: 'deny', action: 'shell', resources: ['denied'] }
  const ctx = { session: { get: async () => ({}) } }
  await createExecutionGuard(root, ctx).onPermission(event)
  const restored = restart()
  assert.equal(restored.blocker.class, 'BLOCKED_PERMISSION')
  assert.equal(restored.permission_stops.length, 1)
  assert.equal(restored.revision, 2, 'observation does not forge a leased log append')
  await createExecutionGuard(root, ctx).onPermission(event)
  assert.equal(restart().permission_stops.length, 1, 'observation idempotent across guard restart')
  await assert.rejects(createExecutionGuard(root, ctx).beforeTool({ sessionID: 'owner', tool: 'shell', input: {} }), /BLOCKED_PERMISSION/)
  const snap = await core.snapshot()
  await assert.rejects(core.commit({ operation_id: 'escape-pending-denial', operation_type: 'DISPATCH_RESERVE', body: { dispatch_id: 'build', purpose: 'BUILD', reserved_seconds: 10 } }, { holder_session_id: 'replacement-owner', expected_revision: snap.state.revision, lease_fencing_token: snap.lease.fencing_token }), /BLOCKED_PERMISSION/)
  await assert.rejects(call({ action: 'approve_mandate', execution_id: 'escape', session_id: 'replacement-owner', epic_artifact_id: 'epic-p4' }), /ownership|bound/)
  const recovered = await call({ action: 'reconcile', session_id: 'replacement-owner' })
  assert.equal(recovered.blocker.class, 'BLOCKED_PERMISSION')
  assert.equal(recovered.revision, 3)
  await call({ action: 'reconcile', session_id: 'replacement-owner' })
  assert.equal(restart().revision, 3)
  assert.equal((await core.snapshot()).events.filter(e => e.operation_type === 'BLOCK').length, 1)
}))

test('P4 #13 CAS conflict: durable observation blocks progress until fenced idempotent reconciliation', async () => fixture(async ({ root, call, restart }) => {
  const core = await createExecutionController({ dir: join(root, '.harness/execution/controller/E') })
  const lease = await core.acquire('owner')
  const snap = await core.snapshot()
  assert.equal(typeof core.observePermissionRejection, 'function', 'core must persist denial independently of the execution lease')
  const observation = await core.observePermissionRejection({ session_id: 'owner', identity: { request_id: 'rejected-cas' } })
  await call({ action: 'checkpoint', checkpoint_id: 'racing-audit', note: 'audit remains permitted' })
  await assert.rejects(core.commit(observation.operation, { holder_session_id: 'owner', expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token }), /Stale revision/)
  assert.equal(restart().blocker.class, 'BLOCKED_PERMISSION')
  await assert.rejects(call({ action: 'reserve', purpose: 'BUILD', dispatch_id: 'escape', reserved_seconds: 10 }), /BLOCKED_PERMISSION/)
  await call({ action: 'reconcile' })
  const count = restart().revision
  await call({ action: 'reconcile' })
  assert.equal(restart().revision, count)
}))

test('P4 #6 during repair: expired live reservation stops tools but still settles cumulative consumption', async () => fixture(async ({ root, call, rejectedA, authorize }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const a = await rejectedA()
  await authorize(a)
  await call({ action: 'reserve', dispatch_id: 'repair', purpose: 'REPAIR', candidate_id: a.candidate_id, reserved_seconds: 10 })
  await call({ action: 'prepare_launch', dispatch_id: 'repair' })
  await call({ action: 'record_launch', dispatch_id: 'repair', launch_session_id: 'repair-session' })
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } }, { now: () => Date.now() + 60000 })
  await assert.rejects(guard.beforeTool({ sessionID: 'repair-session', agent: 'harness-builder', tool: 'shell', input: {} }), /BUDGET_EXHAUSTED/)
  await call({ action: 'record_finish', dispatch_id: 'repair', result: 'stopped' })
  const s = await call({ action: 'reconcile', dispatch_id: 'repair' })
  assert.equal(s.blocker.class, 'BUDGET_EXHAUSTED')
  assert.equal(s.budget.used_seconds, 30)
  assert.equal(s.budget.reserved_seconds, 0)
  assert.equal(s.wu.repair_cycle_count, 1)
}))

test('P4 review R1: controller consequential tools cannot bypass a funded dispatch', async () => fixture(async ({ root, call, rejectedA }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
  for (const stage of ['before build', 'after rejected review']) {
    if (stage === 'after rejected review') await rejectedA()
    for (const tool of ['shell', 'patch', 'edit', 'webfetch', 'execute']) {
      await assert.rejects(guard.beforeTool({ sessionID: 'owner', tool, input: {} }), /funded|reservation|dispatch/)
    }
    await guard.beforeTool({ sessionID: 'owner', tool: 'read', input: { path: 'wu.md' } })
    await guard.beforeTool({ sessionID: 'owner', tool: 'harness_execution_controller', input: { action: 'status', execution_id: 'E' } })
  }
  assert.equal((await call({ action: 'status' })).budget.used_seconds, 20)
}))

test('P4 review R2: unresolved blocker cannot be replaced by another recoverable obligation', async () => fixture(async ({ call, restart }) => {
  await call({ action: 'block', blocker_id: 'a', class: 'BLOCKED_TOOLING', failure_signature: 'resource-a' })
  for (const cls of ['BLOCKED_TOOLING', 'BLOCKED_EXTERNAL_FACT', 'BLOCKED_ARCHITECTURE']) {
    await assert.rejects(call({ action: 'block', blocker_id: `b-${cls}`, class: cls, failure_signature: 'resource-b' }), /unresolved|replace/i)
  }
  assert.equal(restart().blocker.blocker_id, 'a')
  const s = await call({ action: 'block', blocker_id: 'terminal', class: 'BLOCKED_PERMISSION', failure_signature: 'denied' })
  assert.equal(s.blocker.class, 'BLOCKED_PERMISSION')
  assert.deepEqual(s.blocker_history.map(b => b.blocker_id), ['a', 'terminal'])
}))

test('P4 review R3: recovery action claim is single-use across restart, failure and success', async () => {
  for (const outcome of ['crash', 'error', 'completed']) await fixture(async ({ root, call, rejectedA, restart }) => {
    const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
    const a = await rejectedA()
    await call({ action: 'block', blocker_id: 'tool', class: 'BLOCKED_TOOLING', failure_signature: 'resource' })
    await call({ action: 'authorize_recovery', blocker_id: 'tool', recovery_action_id: 'restore', dispatch_id: 'r', hypothesis: 'restore', progress_evidence_ids: ['tool'] })
    await call({ action: 'reserve', dispatch_id: 'r', purpose: 'RECOVERY', candidate_id: a.candidate_id, reserved_seconds: 5 })
    await call({ action: 'prepare_launch', dispatch_id: 'r' })
    await call({ action: 'record_launch', dispatch_id: 'r', launch_session_id: 'recovery-session' })
    const ctx = { session: { get: async () => ({}) } }
    const event = { sessionID: 'recovery-session', agent: 'harness-builder', tool: 'read', input: { path: 'payload.txt' }, id: 'once' }
    const guard = createExecutionGuard(root, ctx)
    await guard.beforeTool(event)
    assert.equal(restart().recoveries.tool.action_claim.tool_call_id, 'once')
    if (outcome !== 'crash') await guard.afterTool({ ...event, status: outcome, result: { content: 'restored' }, error: { message: 'resource still missing' } })
    const fresh = createExecutionGuard(root, ctx)
    await assert.rejects(fresh.beforeTool({ ...event, id: 'retry' }), /claimed|NO_PROGRESS|attempt|consumed/)
    await assert.rejects(fresh.beforeTool(event), /claimed|NO_PROGRESS|attempt|consumed/)
    if (outcome === 'error') assert.equal(restart().blocker.class, 'NO_PROGRESS')
    if (outcome === 'crash') {
      await assert.rejects(fresh.beforeTool({ ...event, tool: 'harness_run_verification', input: { candidate_id: a.candidate_id, verification_check_id: 'check' } }), /unconfirmed|ambiguous|successful/)
    }
  })
})

test('P4 review R4: invalid legacy logs are isolated, relevant history and corrupt Phase4 remain fail-closed', async () => fixture(async ({ root, call }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const { controllerStates } = await import('../../src/execution/ownership.js')
  const { writeLog, readLog } = await import('../../src/execution/event-log.js')
  const dir = join(root, '.harness/execution/controller/legacy-invalid')
  await mkdir(dir)
  const bad = { sequence: 1, event_id: 'old', operation_id: 'old', operation_type: 'DISPATCH_LAUNCH', previous_revision: 0, next_revision: 1, body: { dispatch_id: 'missing', session_id: 'old-session' } }
  await writeLog(join(dir, 'events.ndjson'), [bad])
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
  await guard.onPermission({ sessionID: 'old-session', effect: 'deny', action: 'shell', resources: ['denied'] })
  await guard.onEvent({ type: 'permission.replied', data: { sessionID: 'old-session', requestID: 'old-rejection', reply: 'reject' } })
  await guard.beforeTool({ sessionID: 'unrelated', tool: 'shell', input: {} })
  await guard.beforeTool({ sessionID: 'owner', tool: 'read', input: { path: 'wu.md' } })
  await call({ action: 'checkpoint', checkpoint_id: 'valid-with-old-history' })
  const inventory = await controllerStates(join(root, '.harness/execution/controller'))
  assert.ok(inventory.find(r => r.dir === dir).projection_error)
  await assert.rejects(guard.beforeTool({ sessionID: 'old-session', tool: 'shell', input: {} }), /historical|projection/i)
  await assert.rejects(guard.beforeTool({ sessionID: 'unrelated', tool: 'harness_execution_controller', input: { execution_id: 'legacy-invalid', action: 'reserve' } }), /historical|projection/i)
  await guard.onPermission({ sessionID: 'owner', effect: 'deny', action: 'shell', resources: ['current-denial'] })
  assert.equal((await call({ action: 'status' })).blocker.class, 'BLOCKED_PERMISSION', 'historical rejection must not break later valid permission observation')
  await guard.beforeTool({ sessionID: 'unrelated', tool: 'shell', input: {} })
  const log = join(root, '.harness/execution/controller/E/events.ndjson')
  const events = await readLog(log)
  await writeLog(log, [...events, { ...bad, sequence: events.length + 1, previous_revision: events.length, next_revision: events.length + 1 }])
  await assert.rejects(guard.beforeTool({ sessionID: 'owner', tool: 'read', input: {} }), /dispatch|projection|Phase 4|BLOCKED_PERMISSION/i)
}))

function wrappedController(input, notation = 'bracket') {
  return {
    sessionID: input.session_id ?? 'owner',
    tool: 'execute',
    input: { code: `return await ${notation === 'dot' ? 'tools.harness_execution_controller' : 'tools["harness_execution_controller"]'}(${JSON.stringify(input)})` },
    id: 'wrapped-call',
  }
}

test('P4 transport: controller-session wrapped read reaches the same authority checks as direct', async () => fixture(async ({ root, call }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
  for (const notation of ['bracket', 'dot']) {
    await guard.beforeTool(wrappedController({ action: 'status', execution_id: 'E' }, notation))
    // Wrapped mutation from controller session is admitted exactly like a direct call.
    await guard.beforeTool(wrappedController({ action: 'reserve', execution_id: 'E', dispatch_id: 'wrapped-build', purpose: 'BUILD', reserved_seconds: 10 }, notation))
  }
  // The guard itself does not execute the tool; verify controller state is untouched.
  const s = await call({ action: 'status' })
  assert.equal(s.budget.reserved_seconds, 0)
}))

test('P4 transport: wrapped mismatched session_id is rejected for mutations', async () => fixture(async ({ root }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
  const event = wrappedController({ action: 'reserve', execution_id: 'E', dispatch_id: 'x', purpose: 'BUILD', reserved_seconds: 10 })
  event.sessionID = 'owner'
  event.input.code = `return await tools["harness_execution_controller"](${JSON.stringify({ action: 'reserve', execution_id: 'E', dispatch_id: 'x', purpose: 'BUILD', reserved_seconds: 10, session_id: 'other' })})`
  await assert.rejects(guard.beforeTool(event), /session identity|impersonat/i)
}))

test('P4 transport: wrapped specialist mutation is rejected', async () => fixture(async ({ root, call }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  await call({ action: 'reserve', dispatch_id: 'build', purpose: 'BUILD', reserved_seconds: 10 })
  await call({ action: 'prepare_launch', dispatch_id: 'build' })
  await call({ action: 'record_launch', dispatch_id: 'build', launch_session_id: 'build-session' })
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
  for (const notation of ['bracket', 'dot']) {
    const event = wrappedController({ action: 'reserve', execution_id: 'E', dispatch_id: 'other', purpose: 'BUILD', reserved_seconds: 10 }, notation)
    event.sessionID = 'build-session'
    await assert.rejects(guard.beforeTool(event), /Specialist cannot mutate/)
  }
}))

test('P4 transport: exact live specialist wrapped mutation is denied before the lease, even before its dispatch binding lands', async () => fixture(async ({ root, call }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  await call({ action: 'reserve', dispatch_id: 'build', purpose: 'BUILD', reserved_seconds: 10 })
  await call({ action: 'prepare_launch', dispatch_id: 'build' })
  const ctx = { session: { get: async ({ sessionID }) => ({ parentID: sessionID === 'child-canary' ? 'owner' : undefined }) } }
  const code = 'return await tools.harness_execution_controller({\n  action: "checkpoint",\n  execution_id: "E",\n  checkpoint_id: "specialist-mutation-canary"\n})'
  const core = await createExecutionController({ dir: join(root, '.harness/execution/controller/E') })

  // The specialist mutation and its dispatch-binding call can arrive in the same
  // assistant turn. The mutation must be denied even when the binding is not yet
  // visible, before any controller tool execution, lease acquisition or revision.
  const beforeRace = await core.snapshot()
  const guard = createExecutionGuard(root, ctx)
  await assert.rejects(
    guard.beforeTool({ sessionID: 'child-canary', agent: 'harness-builder', tool: 'execute', input: { code }, id: 'wrapped-race' }),
    /Specialist cannot mutate execution authority/,
  )
  // A direct harness_execution_controller call from the same specialist is identical.
  await assert.rejects(
    createExecutionGuard(root, ctx).beforeTool({ sessionID: 'child-canary', agent: 'harness-builder', tool: 'harness_execution_controller', input: { action: 'checkpoint', execution_id: 'E', checkpoint_id: 'direct-race' }, id: 'direct-race' }),
    /Specialist cannot mutate execution authority/,
  )
  const afterRace = await core.snapshot()
  assert.equal(afterRace.state.revision, beforeRace.state.revision)
  assert.equal(afterRace.lease?.holder_session_id, beforeRace.lease?.holder_session_id)
  assert.equal(afterRace.lease?.fencing_token, beforeRace.lease?.fencing_token)

  // Sequential live shape: owner claims the launch, the child binds it with a read,
  // then the specialty mutation is denied with the same authority error.
  await guard.beforeTool({ sessionID: 'owner', tool: 'subagent', id: 'launch-canary', input: { agent: 'harness-builder', prompt: 'build exact WU' } })
  await guard.beforeTool({ sessionID: 'child-canary', agent: 'harness-builder', tool: 'read', input: { path: 'wu.md' }, id: 'bind-read' })
  const launched = await call({ action: 'status' })
  assert.equal(launched.dispatches[0].status, 'launched')
  assert.equal(launched.dispatches[0].session_id, 'child-canary')
  const beforeBound = await core.snapshot()
  await assert.rejects(
    guard.beforeTool({ sessionID: 'child-canary', agent: 'harness-builder', tool: 'execute', input: { code }, id: 'wrapped-launched' }),
    /Specialist cannot mutate execution authority/,
  )
  const afterBound = await core.snapshot()
  assert.equal(afterBound.state.revision, beforeBound.state.revision)
  assert.equal(afterBound.lease?.holder_session_id, beforeBound.lease?.holder_session_id)
  assert.equal(afterBound.lease?.fencing_token, beforeBound.lease?.fencing_token)
}))

test('P4 transport: Q1 — an unrecognized Code Mode controller call is denied at the real tool boundary', async () => fixture(async ({ root }) => {
  const { extractControllerInvocation } = await import('../../src/execution/controller-transport.js')
  // Valid Code Mode programs that really call the controller but are deliberately
  // NOT recognized by structural extraction, so the outer guard sees generic execute.
  const unrecognized = [
    "const f = tools['harness_execution_controller']; return await f({ action: 'checkpoint', execution_id: 'E' })",
    "return await tools['harness_execution_controller']({ action: 'checkpoint', execution_id: 'E' })",
  ]
  for (const code of unrecognized) {
    assert.equal(extractControllerInvocation({ tool: 'execute', input: { code } }), null, code)
  }

  const core = await createExecutionController({ dir: join(root, '.harness/execution/controller/E') })
  const before = await core.snapshot()
  for (const action of ['checkpoint', 'reserve', 'block', 'release']) {
    await assert.rejects(
      assertToolControllerAuthority(root, { action, execution_id: 'E', session_id: 'specialist-session', checkpoint_id: 'q1', dispatch_id: 'q1', class: 'BLOCKED_TOOLING' }),
      /Specialist cannot mutate execution authority/,
      action,
    )
  }
  const after = await core.snapshot()
  assert.equal(after.state.revision, before.state.revision)
  assert.equal(after.lease?.holder_session_id, before.lease?.holder_session_id)
  assert.equal(after.lease?.fencing_token, before.lease?.fencing_token)

  // Read-only controller actions retain their semantics for any session.
  await assertToolControllerAuthority(root, { action: 'status', execution_id: 'E', session_id: 'specialist-session' })
  await assertToolControllerAuthority(root, { action: 'recover', execution_id: 'E', session_id: 'specialist-session' })
  await assertToolControllerAuthority(root, { action: 'verify', execution_id: 'E', session_id: 'specialist-session' })
  // The mandate controller may still mutate.
  await assertToolControllerAuthority(root, { action: 'checkpoint', execution_id: 'E', session_id: 'owner', checkpoint_id: 'owner-ok' })
}))

test('P4 transport: Q1 — specialist is denied before acquire even when the controller lease has expired', async () => fixture(async ({ root }) => {
  let now = 1000
  const core = await createExecutionController({ dir: join(root, '.harness/execution/controller/E'), now: () => now })
  const lease = await core.acquire('owner')
  const before = await core.snapshot()
  now += 3_600_000 // far beyond the lease TTL: a specialist could otherwise transfer it
  await assert.rejects(
    assertToolControllerAuthority(root, { action: 'checkpoint', execution_id: 'E', session_id: 'specialist-session', checkpoint_id: 'expired-q1' }),
    /Specialist cannot mutate execution authority/,
  )
  const after = await core.snapshot()
  assert.equal(after.state.revision, before.state.revision)
  assert.equal(after.lease?.holder_session_id, 'owner')
  assert.equal(after.lease?.fencing_token, lease.fencing_token)
  assert.ok(after.lease?.expires_at <= now, 'the pre-existing lease really was expired')
}))

test('P4 transport: unfunded wrapped controller mutation remains rejected under budget exhaustion', async () => fixture(async ({ root, call, rejectedA, authorize }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const a = await rejectedA()
  await authorize(a)
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
  await assert.rejects(guard.beforeTool(wrappedController({ action: 'reserve', execution_id: 'E', dispatch_id: 'escape', purpose: 'BUILD', reserved_seconds: 10 })), /BUDGET_EXHAUSTED|blocked/i)
}, { seconds: 25 }))

test('P4 transport: generic execute does not acquire controller settlement privileges', async () => fixture(async ({ root }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
  await assert.rejects(guard.beforeTool({ sessionID: 'owner', tool: 'execute', input: { code: 'return 42' }, id: 'generic' }), /funded|reservation|dispatch/)
  await assert.rejects(guard.beforeTool({ sessionID: 'owner', tool: 'execute', input: { code: 'return await tools["harness_execution_controller"]({ action: "status", execution_id: "E" }) + 1' }, id: 'generic' }), /funded|reservation|dispatch/)
  await assert.rejects(guard.beforeTool({ sessionID: 'owner', tool: 'execute', input: { code: 'const x = await tools.harness_execution_controller({ action: "status", execution_id: "E" }); return { x, extra: 42 }' }, id: 'smuggled' }), /funded|reservation|dispatch/)
}))

test('P4 transport: afterTool records wrapped controller recovery action evidence consistently', async () => fixture(async ({ root, call, rejectedA }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const a = await rejectedA()
  await call({ action: 'block', blocker_id: 't', class: 'BLOCKED_TOOLING', failure_signature: 'resource' })
  const input = { action: 'authorize_recovery', blocker_id: 't', recovery_action_id: 'ctl-restore', dispatch_id: 'r', hypothesis: 'restore', progress_evidence_ids: ['t'] }
  await call(input)
  await call({ action: 'reserve', dispatch_id: 'r', purpose: 'RECOVERY', candidate_id: a.candidate_id, reserved_seconds: 5 })
  await call({ action: 'prepare_launch', dispatch_id: 'r' })
  await call({ action: 'record_launch', dispatch_id: 'r', launch_session_id: 'recovery-session' })
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
  const event = wrappedController({ action: 'status', execution_id: 'E' })
  event.sessionID = 'recovery-session'
  event.agent = 'harness-builder'
  await guard.beforeTool(event)
  await guard.afterTool({ ...event, status: 'completed', result: { ok: true } })
  const core = await createExecutionController({ dir: join(root, '.harness/execution/controller/E') })
  const snap = await core.snapshot()
  assert.equal(snap.state.recoveries.t.action_evidence.status, 'PASS')
  assert.equal(snap.state.recoveries.t.action_evidence.tool_call_id, 'wrapped-call')
}, { overrides: { recovery_actions: [{ id: 'ctl-restore', class: 'BLOCKED_TOOLING', actor: 'harness-builder', tool: 'harness_execution_controller', input: { action: 'status', execution_id: 'E' }, reserved_seconds: 5, success_check_id: 'check' }] } }))

// Focused Phase 4 Code-Mode transport amendment: owner tools other than the
// controller must keep their logical identity through the execute wrapper, and
// real tool boundaries must be transport-independent.

function wrappedHarness(tool, input, notation = 'dot') {
  return {
    sessionID: 'owner',
    tool: 'execute',
    input: { code: `return await ${notation === 'dot' ? `tools.${tool}` : `tools["${tool}"]`}(${JSON.stringify(input)})` },
    id: `wrapped-${tool}`,
  }
}

test('P4 transport: owner wrapped freeze admitted only after a settled BUILD/REPAIR handoff', async () => fixture(async ({ root, call, dispatch }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const { assertToolFreezeAuthority } = await import('../../src/execution/controller-tool.js')
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })

  // Before any BUILD/REPAIR settlement the same wrapper is rejected.
  await assert.rejects(guard.beforeTool(wrappedHarness('harness_freeze_candidate', { wu_id: 'WU-P4' })), /funded|reservation|dispatch/)
  await assert.rejects(assertToolFreezeAuthority(root, { wu_id: 'WU-P4' }, 'owner'), /settled|handoff/i)

  await dispatch('build', 'BUILD')

  // After one settled BUILD the owner wrapper is admitted by the guard...
  await guard.beforeTool(wrappedHarness('harness_freeze_candidate', { wu_id: 'WU-P4' }))
  await guard.beforeTool(wrappedHarness('harness_freeze_candidate', { wu_id: 'WU-P4' }, 'bracket'))
  // ...and the real tool boundary admits the owner path.
  await assertToolFreezeAuthority(root, { wu_id: 'WU-P4' }, 'owner')
  // Unfunded generic execute stays rejected.
  await assert.rejects(guard.beforeTool({ sessionID: 'owner', tool: 'execute', input: { code: 'return 42' }, id: 'generic' }), /funded|reservation|dispatch/)
}))

test('P4 transport: specialist cannot freeze via recognized wrapper or smuggled syntax', async () => fixture(async ({ root, call, dispatch, candidate }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const { assertToolFreezeAuthority } = await import('../../src/execution/controller-tool.js')
  const { extractHarnessToolInvocation } = await import('../../src/execution/controller-transport.js')
  const a = await (async () => {
    await dispatch('build', 'BUILD')
    const cand = await candidate('A')
    await call({ action: 'record_candidate', candidate_id: cand.candidate_id, dispatch_id: 'build' })
    return cand
  })()
  // A live specialist (REVIEW) dispatch exists, so the session is bound.
  await call({ action: 'reserve', dispatch_id: 'review-live', purpose: 'REVIEW', candidate_id: a.candidate_id, reserved_seconds: 10 })
  await call({ action: 'prepare_launch', dispatch_id: 'review-live' })
  await call({ action: 'record_launch', dispatch_id: 'review-live', launch_session_id: 'session-review-live' })
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })

  // Recognized wrapper from a specialist dispatch is denied early.
  const event = wrappedHarness('harness_freeze_candidate', { wu_id: 'WU-P4' })
  event.sessionID = 'session-review-live'
  event.agent = 'harness-reviewer'
  await assert.rejects(guard.beforeTool(event), /delegate|authority|freeze/i)

  // An unrecognized Code-Mode form reaches the real tool as generic execute;
  // extraction stays null and the boundary itself fails closed.
  const smuggled = "const f = tools['harness_freeze_candidate']; return await f({ wu_id: 'WU-P4' })"
  assert.equal(extractHarnessToolInvocation({ tool: 'execute', input: { code: smuggled } }), null)
  await assert.rejects(assertToolFreezeAuthority(root, { wu_id: 'WU-P4' }, 'session-review-live'), /mandate controller|owner/i)
  await assert.rejects(assertToolFreezeAuthority(root, { wu_id: 'WU-P4' }, 'owner-but-not-bound'), /mandate controller|owner/i)
}))

test('P4 transport: reviewer wrapped verification admitted only with a live bound dispatch', async () => fixture(async ({ root, call, dispatch, candidate }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const { assertToolVerificationAuthority } = await import('../../src/execution/controller-tool.js')
  await dispatch('build', 'BUILD')
  const a = await candidate('A')
  await call({ action: 'record_candidate', candidate_id: a.candidate_id, dispatch_id: 'build' })
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })

  // No valid REVIEW/RECOVERY dispatch for this session yet: both reject.
  const code = (candidateId) => `return await tools.harness_run_verification({ candidate_id: ${JSON.stringify(candidateId)}, verification_check_id: 'check' })`
  // Early call from a session bound only to a settled BUILD is rejected.
  const early = { sessionID: 'session-build', agent: 'harness-builder', tool: 'execute', input: { code: code(a.candidate_id) }, id: 'v-early' }
  await assert.rejects(guard.beforeTool(early), /settled|launched|reservation|reserved/i)
  await assert.rejects(assertToolVerificationAuthority(root, { candidate_id: a.candidate_id }, 'session-review-live'), /live|bound/i)

  await call({ action: 'reserve', dispatch_id: 'review-live', purpose: 'REVIEW', candidate_id: a.candidate_id, reserved_seconds: 10 })
  await call({ action: 'prepare_launch', dispatch_id: 'review-live' })
  await call({ action: 'record_launch', dispatch_id: 'review-live', launch_session_id: 'session-review-live' })

  // Live REVIEW dispatch plus matching candidate: admitted through the wrapper.
  await guard.beforeTool({ sessionID: 'session-review-live', agent: 'harness-reviewer', tool: 'execute', input: { code: code(a.candidate_id) }, id: 'v-live' })
  await assertToolVerificationAuthority(root, { candidate_id: a.candidate_id }, 'session-review-live')

  // Wrong candidate: rejected by both.
  const wrong = 'cand-' + '0'.repeat(64)
  await assert.rejects(guard.beforeTool({ sessionID: 'session-review-live', agent: 'harness-reviewer', tool: 'execute', input: { code: code(wrong) }, id: 'v-wrong' }), /candidate|bound/i)
  await assert.rejects(assertToolVerificationAuthority(root, { candidate_id: wrong }, 'session-review-live'), /live|bound/i)

  // An unreserved session cannot bind to the live dispatch at the boundary.
  await assert.rejects(assertToolVerificationAuthority(root, { candidate_id: a.candidate_id }, 'intruder'), /live|bound/i)
}))

test('P4 transport: readiness/status wrapper diagnostics preserve current semantics', async () => fixture(async ({ root, call }) => {
  const { createExecutionGuard } = await import('../../src/execution/runtime-guard.js')
  const guard = createExecutionGuard(root, { session: { get: async () => ({}) } })
  for (const [tool, input] of [['harness_project_status', {}], ['harness_check_agent_readiness', {}], ['harness_check_execution_readiness', { wu_id: 'WU-P4' }]]) {
    // Wrapped diagnostics are admitted for the unreserved owner exactly like a
    // direct call, with no dispatch and no blocker.
    await guard.beforeTool(wrappedHarness(tool, input))
    await guard.beforeTool({ sessionID: 'owner', tool, input })
  }
  // A wrapper for a tool outside the whitelist stays generic execute: rejected.
  await assert.rejects(
    guard.beforeTool({ sessionID: 'owner', tool: 'execute', input: { code: 'return await tools.harness_search_knowledge({ query: "abc" })' }, id: 'x' }),
    /funded|reservation|dispatch/,
  )
}))
