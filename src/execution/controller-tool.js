// Phase 2 runtime instrument: `harness_execution_controller`.
//
// This is a control surface over the durable execution controller, NOT new
// authority. Every mutating action routes through the controller's `commit()`
// with an `operation_id` + `expected_revision` + `holder_session_id` +
// `lease_fencing_token`; no action ever writes `state.json` or the event log
// directly. The tool is inert unless invoked, and it never touches OpenCode
// configuration, permissions, or agents.
//
// The split between `prepare_launch` and `record_launch` makes the crash window
// observable:
//
//   PENDING_LAUNCH ──external side effect──▶ LAUNCHED (identity persisted)
//
// A crash after the side effect but before `record_launch` is exactly the
// AMBIGUOUS hazard: recovery marks AMBIGUOUS and never auto-launches.

import { join, resolve, relative } from "node:path"
import { readFile, lstat } from 'node:fs/promises'
import { sha256 } from './serialize.js'
import { readLog, validateLog } from "./event-log.js"
import { project, deriveBudget } from "./state.js"
import { createExecutionController } from "./execution.js"
import { assertControllerMutationAuthority } from "./controller-authority.js"
import { createCandidateRegistry } from "./candidate-registry.js"
import { readVerificationReceipt } from "./verification-results.js"
import { findApprovedEpic } from "../project-knowledge.js"
import { DISPATCH_STATUS, RESERVATION_STATUS, MANDATE_AUTHORITY } from "./constants.js"

function sanitizeId(raw, label) {
  const value = String(raw ?? "")
  const id = value.replace(/[^A-Za-z0-9._-]/g, "_")
  if (!id || id === "." || id === "..") throw new Error(`${label} must be a non-empty identifier that is not '.' or '..'.`)
  return id
}

// Read-only summary of the projected state + derived budget + dispatch ledger.
async function summary(controller) {
  const snap = await controller.snapshot()
  const { state, lease } = snap
  const budget = deriveBudget(state.budget)
  return {
    execution_id: state.execution_id,
    revision: state.revision,
    budget: {
      total_seconds: budget.total_seconds,
      used_seconds: budget.used_seconds,
      reserved_seconds: budget.reserved_seconds,
      available_seconds: budget.available_seconds,
      exhausted: budget.exhausted,
      overrun: budget.overrun,
    },
    dispatches: Object.entries(state.dispatches).map(([dispatch_id, d]) => ({
      dispatch_id,
      status: d.status,
      session_id: d.session_id ?? null,
      reserved_seconds: d.reserved_seconds,
      reservation_status: d.reservation_status,
      actual_consumption: d.actual_consumption,
    })),
    fencing_token: lease?.fencing_token ?? null,
    blocker: snap.effective_blocker,
    permission_stops: snap.permission_stops,
    completed: state.completed,
    mandate: state.mandate,
    wu: state.wu,
    candidates: state.candidates,
    reviews: state.reviews,
    checkpoint: state.checkpoint,
    repair: state.repair ?? null,
    repair_history: state.repair_history ?? [],
    recoveries: state.recoveries ?? {},
    blocker_history: state.blocker_history ?? [],
  }
}

// Strictly read-only invariant check. Rebuilds the projection from the raw log
// file (bypassing any controller state) and asserts ledger/accounting/lease
// coherence. Used after every restart to prove the durable core is intact.
async function verify(controller) {
  const snap = await controller.snapshot()
  const { events, state, lease } = snap
  const checks = {}

  // Independent rebuild from the raw log file — proves the projection is
  // derivable from the durable source of truth alone.
  const rawEvents = validateLog(await readLog(join(controller.dir, "events.ndjson")))
  const rebuilt = project(rawEvents)
  checks["projection rebuilds from the raw event log"] = JSON.stringify(rebuilt) === JSON.stringify(state)

  // Reservation aggregate is a projection of live dispatch reservations.
  const activeReservations = Object.values(state.dispatches)
    .filter((d) => d.reservation_status === RESERVATION_STATUS.RESERVED)
    .reduce((sum, d) => sum + d.reserved_seconds, 0)
  checks["reservation aggregate equals active dispatch reservations"] = state.budget.reserved_seconds === activeReservations

  // Terminal dispatch invariants: AMBIGUOUS retains its reservation; RELEASED
  // and RESULT_RECONCILED hold no live reservation (their reservation_status is
  // the authority, not the historical reserved_seconds field).
  checks["terminal dispatches satisfy reservation invariants"] = Object.entries(state.dispatches).every(([, d]) => {
    if (d.status === DISPATCH_STATUS.AMBIGUOUS) return d.reservation_status === RESERVATION_STATUS.RESERVED
    if (d.status === DISPATCH_STATUS.RELEASED) return d.reservation_status === RESERVATION_STATUS.RELEASED
    if (d.status === DISPATCH_STATUS.RESULT_RECONCILED) return d.reservation_status === RESERVATION_STATUS.CONSUMED
    return true
  })

  // Fencing is a positive integer generation.
  checks["fencing token is a positive integer generation"] = Number.isInteger(lease?.fencing_token) && lease?.fencing_token >= 1

  // No duplicate operation_id in the log (idempotency keeps the index conflict-free).
  checks["operation ids are unique in the log"] = new Set(events.map((e) => e.operation_id)).size === events.length

  // Dispatch statuses are valid vocabulary.
  checks["dispatch statuses are valid vocabulary"] = Object.values(state.dispatches).every((d) =>
    Object.values(DISPATCH_STATUS).includes(d.status) && Object.values(RESERVATION_STATUS).includes(d.reservation_status),
  )

  const passed = Object.values(checks).every(Boolean)
  return { passed, checks }
}

// A single mutating action routed through commit() with a freshly-acquired
// lease and a freshly-read revision (compare-and-swap still guards races).
async function commitAction(controller, holder, operation_id, operation_type, body) {
  const lease = await controller.acquire(holder)
  const snap = await controller.snapshot()
  const res = await controller.commit(
    { operation_id, operation_type, body },
    { holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token },
  )
  return res
}

export async function runExecutionController(projectRoot, input, candidateRegistry) {
  const executionId = sanitizeId(input.execution_id, "execution_id")
  const dir = join(projectRoot, ".harness", "execution", "controller", executionId)
  const controller = await createExecutionController({ dir, lease_ttl_ms: 30000 })
  const registry = candidateRegistry ?? createCandidateRegistry({ dir: join(projectRoot, ".harness", "execution") })
  const holder = String(input.session_id ?? `controller:${executionId}`)
  const action = String(input.action ?? "status")

  if (action === "init") {
    const mandateId = String(input.mandate_id ?? `${executionId}-MANDATE-001`)
    const mandateRevision = String(input.mandate_revision ?? "rev-0")
    const totalSeconds = Number(input.total_seconds ?? 60)
    const res = await commitAction(controller, holder, `${executionId}:mandate`, "MANDATE_APPROVE", {
      execution_id: `${executionId}:exec`,
      mandate_id: mandateId,
      mandate_revision: mandateRevision,
      max_wus: Number(input.max_wus ?? 4),
      total_seconds: totalSeconds,
      authority_kind: MANDATE_AUTHORITY.PROBE,
    })
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "approve_mandate") {
    const epicArtifactId = String(input.epic_artifact_id ?? "")
    if (!epicArtifactId) throw new Error("approve_mandate requires epic_artifact_id (an APPROVED Epic artifact in the knowledge index).")
    const epic = await findApprovedEpic(projectRoot, epicArtifactId)
    if (epic.mandate.repair_policy) await verifyWUContract(projectRoot, epic.mandate.repair_policy)
    const mandateId = String(input.mandate_id ?? `${executionId}-MANDATE-001`)
    const res = await commitAction(controller, holder, `${executionId}:mandate`, "MANDATE_APPROVE", {
      execution_id: `${executionId}:exec`,
      mandate_id: mandateId,
      mandate_revision: epic.source_revision,
      max_wus: epic.mandate.max_wus,
      total_seconds: epic.mandate.total_seconds,
      authority_kind: MANDATE_AUTHORITY.OWNER_APPROVED_EPIC,
      source_artifact_id: epic.source_id,
      source_record_key: epic.record_key,
      source_hash: epic.sha256,
      ...(epic.mandate.repair_policy ? { repair_policy: epic.mandate.repair_policy, controller_session_id: holder } : {}),
    })
    return { action, commit_status: res.status, source_artifact_id: epic.source_id, source_hash: epic.sha256, ...(await summary(controller)) }
  }

  if (action === "activate_wu") {
    const wuId = String(input.wu_id ?? "")
    if (!wuId) throw new Error("activate_wu requires wu_id.")
    const mandateId = String(input.mandate_id ?? "")
    if (!mandateId) throw new Error("activate_wu requires mandate_id (must match the approved mandate).")
    const snap = await controller.snapshot()
    if (snap.state.mandate?.authority_kind !== MANDATE_AUTHORITY.OWNER_APPROVED_EPIC) {
      throw new Error("activate_wu requires an OWNER_APPROVED_EPIC mandate (use approve_mandate, not init).")
    }
    if (snap.state.mandate.repair_policy) await verifyWUContract(projectRoot, snap.state.mandate.repair_policy)
    const res = await commitAction(controller, holder, `${executionId}:activate:${wuId}`, "WU_ACTIVATE", { wu_id: wuId, mandate_id: mandateId })
    return { action, commit_status: res.status, wu_id: wuId, ...(await summary(controller)) }
  }

  if (action === "status") {
    return { action, ...(await summary(controller)) }
  }

  if (action === "reserve") {
    const dispatchId = requireDispatchId(input)
    const reserved = Number(input.reserved_seconds)
    if (!Number.isFinite(reserved) || reserved < 0) throw new Error("reserve requires a finite non-negative reserved_seconds.")
    const res = await commitAction(controller, holder, `${executionId}:reserve:${dispatchId}`, "DISPATCH_RESERVE", { dispatch_id: dispatchId, reserved_seconds: reserved, ...(input.purpose ? { purpose: input.purpose, candidate_id: input.candidate_id ?? null } : {}) })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "prepare_launch") {
    const dispatchId = requireDispatchId(input)
    const res = await commitAction(controller, holder, `${executionId}:prepare:${dispatchId}`, "DISPATCH_PREPARE", { dispatch_id: dispatchId })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "record_launch") {
    const dispatchId = requireDispatchId(input)
    const launchSessionId = String(input.launch_session_id ?? "")
    if (!launchSessionId) throw new Error("record_launch requires launch_session_id (the external identity persisted at launch).")
    const res = await commitAction(controller, holder, `${executionId}:launch:${dispatchId}`, "DISPATCH_LAUNCH", { dispatch_id: dispatchId, session_id: launchSessionId })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "mark_ambiguous") {
    const dispatchId = requireDispatchId(input)
    const res = await commitAction(controller, holder, `${executionId}:ambiguous:${dispatchId}`, "DISPATCH_MARK_AMBIGUOUS", { dispatch_id: dispatchId })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "record_finish") {
    const dispatchId = requireDispatchId(input)
    const result = input.result ?? null
    const res = await commitAction(controller, holder, `${executionId}:finish:${dispatchId}`, "DISPATCH_FINISH", { dispatch_id: dispatchId, result })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "record_candidate") {
    const candidateId = String(input.candidate_id ?? "")
    if (!candidateId) throw new Error("record_candidate requires candidate_id.")
    const candidate = await registry.load(candidateId)
    if (!candidate) throw new Error(`Cannot record unknown candidate ${candidateId}: not present in the candidate registry.`)
    const lease = await controller.acquire(holder)
    const snap = await controller.snapshot()
    const wuId = snap.state.wu?.wu_id ?? null
    if (!wuId) throw new Error("record_candidate requires an active WU (activate_wu first).")
    const requiredCheckIds = (candidate.verification_contract?.commands ?? []).map((check) => check.id)
    const contractHash = candidate.manifest?.verification_contract?.contract_hash ?? null
    const res = await controller.commit(
      { operation_id: `${executionId}:candidate:${candidateId}`, operation_type: "FREEZE_CANDIDATE", body: { candidate_id: candidateId, wu_id: wuId, manifest_hash: candidate.manifest_hash, tree_hash: candidate.tree_hash, manifest: candidate.manifest ?? null, verification_contract_hash: contractHash, required_check_ids: requiredCheckIds, ...(input.dispatch_id ? { dispatch_id: input.dispatch_id } : {}) } },
      { holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token },
    )
    return { action, commit_status: res.status, candidate_id: candidateId, ...(await summary(controller)) }
  }

  if (action === "record_review") {
    const candidateId = String(input.candidate_id ?? "")
    if (!candidateId) throw new Error("record_review requires candidate_id.")
    const verdict = input.verdict ?? null
    const evidenceIds = Array.isArray(input.verification_evidence_ids) ? input.verification_evidence_ids : []
    if (evidenceIds.length === 0) {
      throw new Error("record_review requires verification_evidence_ids (durable evidence from harness_run_verification).")
    }
    const receiptsDir = join(projectRoot, ".harness", "execution", "verification-results")
    const lease = await controller.acquire(holder)
    const snap = await controller.snapshot()
    const frozenCandidate = snap.state.candidates[candidateId]
    if (!frozenCandidate) throw new Error(`record_review: candidate ${candidateId} not recorded (record_candidate first).`)
    const contractHash = frozenCandidate.verification_contract_hash ?? frozenCandidate.manifest?.verification_contract?.contract_hash ?? null
    const verifiedCheckIds = []
    const receipts = []
    for (const evidenceId of evidenceIds) {
      const receipt = await readVerificationReceipt(receiptsDir, evidenceId)
      if (!receipt) throw new Error(`record_review: evidence ${evidenceId} not found.`)
      if (receipt.candidate_id !== candidateId) throw new Error(`record_review: evidence ${evidenceId} belongs to ${receipt.candidate_id}, not ${candidateId}.`)
      if (contractHash !== null && receipt.verification_contract_hash !== contractHash) throw new Error(`record_review: evidence ${evidenceId} contract hash ${receipt.verification_contract_hash} does not match candidate contract ${contractHash}.`)
      if (receipt.status !== "PASS" && receipt.status !== "FAIL") throw new Error(`record_review: evidence ${evidenceId} status is ${receipt.status}, not a run result.`)
      if (verdict === "PASS" && receipt.status !== "PASS") throw new Error(`record_review: PASS verdict requires all-PASS evidence; ${evidenceId} is ${receipt.status}.`)
      verifiedCheckIds.push(receipt.check_id)
      receipts.push(receipt)
    }
    const res = await controller.commit(
      { operation_id: `${executionId}:review:${candidateId}`, operation_type: "RECORD_REVIEW", body: { candidate_id: candidateId, verdict, candidate_hashes: { manifest_hash: frozenCandidate.manifest_hash, tree_hash: frozenCandidate.tree_hash }, reviewer: input.reviewer ?? null, verification_evidence_ids: evidenceIds, verification_contract_hash: contractHash, verified_check_ids: verifiedCheckIds, ...(snap.state.mandate?.repair_policy ? { dispatch_id: input.dispatch_id, findings: input.findings, evidence_receipts: receipts } : {}) } },
      { holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token },
    )
    return { action, commit_status: res.status, candidate_id: candidateId, ...(await summary(controller)) }
  }

  if (action === "complete_wu") {
    const candidateId = String(input.candidate_id ?? "")
    if (!candidateId) throw new Error("complete_wu requires candidate_id.")
    const res = await commitAction(controller, holder, `${executionId}:wu-complete:${candidateId}`, "WU_COMPLETE", { candidate_id: candidateId })
    return { action, commit_status: res.status, candidate_id: candidateId, ...(await summary(controller)) }
  }

  if (action === "checkpoint") {
    const checkpointId = String(input.checkpoint_id ?? "")
    if (!checkpointId) throw new Error("checkpoint requires checkpoint_id.")
    const res = await commitAction(controller, holder, `${executionId}:checkpoint:${checkpointId}`, "CHECKPOINT", { note: input.note ?? null })
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "block") {
    const cls = String(input.class ?? "")
    if (!cls) throw new Error("block requires class (a BLOCKER_CLASSES value).")
    const res = await commitAction(controller, holder, `${executionId}:block${input.blocker_id ? `:${input.blocker_id}` : ''}`, "BLOCK", { class: cls, reason: input.reason ?? null, ...(input.blocker_id ? { blocker_id: input.blocker_id, failure_signature: input.failure_signature, evidence: input.evidence ?? null, origin_session_id: input.origin_session_id ?? null } : {}) })
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === 'authorize_repair' || action === 'authorize_recovery') {
    const repair = action === 'authorize_repair'
    const key = repair ? input.candidate_id : input.blocker_id
    if (!key) throw new Error('Authorization requires an exact candidate/blocker identity.')
    const body = repair
      ? { candidate_id: key, dispatch_id: input.dispatch_id, hypothesis: input.hypothesis, progress_evidence_ids: input.progress_evidence_ids }
      : { blocker_id: key, recovery_action_id: input.recovery_action_id, dispatch_id: input.dispatch_id, hypothesis: input.hypothesis, progress_evidence_ids: input.progress_evidence_ids }
    const res = await commitAction(controller, holder, `${executionId}:${action}:${key}`, repair ? 'REPAIR_AUTHORIZE' : 'BLOCKER_RECOVERY_AUTHORIZE', body)
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === 'resolve_blocker') {
    if (!input.blocker_id) throw new Error('resolve_blocker requires blocker_id.')
    const evidenceIds = input.verification_evidence_ids ?? []
    const receipts = []
    for (const id of evidenceIds) {
      const r = await readVerificationReceipt(join(projectRoot, '.harness/execution/verification-results'), id)
      if (!r) throw new Error(`Unknown evidence ${id}.`)
      receipts.push(r)
    }
    const res = await commitAction(controller, holder, `${executionId}:resolve:${input.blocker_id}`, 'BLOCKER_RESOLVE', { blocker_id: input.blocker_id, verification_evidence_ids: evidenceIds, evidence_receipts: receipts })
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "complete") {
    const res = await commitAction(controller, holder, `${executionId}:complete`, "COMPLETE", { result: input.result ?? null })
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "reconcile") {
    if (!input.dispatch_id) {
      const lease = await controller.acquire(holder)
      const result = await controller.reconcilePermissionStops({ holder_session_id: holder, lease_fencing_token: lease.fencing_token })
      return { action, permission_reconciliation: result.status, ...(await summary(controller)) }
    }
    const dispatchId = requireDispatchId(input)
    const lease = await controller.acquire(holder)
    const result = await controller.reconcileOne(dispatchId, { holder_session_id: holder, lease_fencing_token: lease.fencing_token })
    return { action, dispatch_id: dispatchId, ...result, ...(await summary(controller)) }
  }

  if (action === "release") {
    const dispatchId = requireDispatchId(input)
    const lease = await controller.acquire(holder)
    const snap = await controller.snapshot()
    const res = await controller.releaseDispatch(dispatchId, { holder_session_id: holder, lease_fencing_token: lease.fencing_token, expected_revision: snap.state.revision })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "recover") {
    return { action, ...(await controller.recover()) }
  }

  if (action === "verify") {
    return { action, ...(await verify(controller)), ...(await summary(controller)) }
  }

  throw new Error(`Unknown action: ${action}.`)
}

// Authoritative, transport-independent backstop at the real
// `harness_execution_controller` tool boundary. Runs before runExecutionController
// and before any lease acquisition. A non-owner of the Phase-4 mandate may never
// execute a mutating controller action, regardless of how the call was written
// (direct call, recognized wrapper, alias or any unrecognized Code Mode form).
export async function assertToolControllerAuthority(projectRoot, input) {
  const executionId = sanitizeId(input.execution_id, "execution_id")
  const dir = join(projectRoot, ".harness", "execution", "controller", executionId)
  const controller = await createExecutionController({ dir })
  const snap = await controller.snapshot()
  const holder = String(input.session_id ?? `controller:${executionId}`)
  assertControllerMutationAuthority(snap.state, holder, String(input.action ?? "status"))
}

function requireDispatchId(input) {
  const id = String(input.dispatch_id ?? "")
  if (!id) throw new Error("This action requires dispatch_id.")
  return id
}

async function verifyWUContract(root, policy) {
  const path = resolve(root, policy.wu_contract_path)
  const rel = relative(root, path)
  if (!rel || rel.startsWith('..')) throw new Error('WU contract escapes project root.')
  let current = root
  for (const part of rel.split('/')) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('WU contract cannot use symlink paths.')
  }
  if (sha256(await readFile(path)) !== policy.wu_contract_hash) throw new Error('WU contract integrity mismatch.')
}
