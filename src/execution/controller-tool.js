import { recoveryAction } from "./progress.js"
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

import { join } from "node:path"
import { compileWuContract } from "./wu-contract.js"
import { wuBudgetUsage } from "./wu-budget.js"
import { stableHash } from "./serialize.js"
import { readLog, validateLog } from "./event-log.js"
import { project, deriveBudget, applyEvent } from "./state.js"
import { createExecutionController } from "./execution.js"
import { createCandidateRegistry } from "./candidate-registry.js"
import { readVerificationReceipt } from "./verification-results.js"
import { findApprovedEpic, findApprovedWuBudgetAmendment, findApprovedAuthorityResolution, verifyDeclaredWorkUnits, readWorkUnitDefinition } from "../project-knowledge.js"
import { DISPATCH_STATUS, RESERVATION_STATUS, MANDATE_AUTHORITY, RECOVERABLE_BLOCKER_CLASSES } from "./constants.js"

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
      consumption_basis: d.consumption_basis ?? "unsettled",
      runtime_usage: d.usage ?? null,
    })),
    fencing_token: lease?.fencing_token ?? null,
    blocker: state.blocker,
    next_action: recoveryAction(state),
    last_blocker_resolution: state.last_blocker_resolution ?? null,
    authority_resolutions: state.authority_resolutions ?? {},
    completed: state.completed,
    mandate: state.mandate,
    wu: state.wu,
    wu_budget: state.wu ? wuBudgetUsage(state, state.wu.wu_id) : null,
    wu_budget_amendments: state.wu_budget_amendments ?? {},
    contract_status: state.wu?.contract ? (state.wu.contract.normalization_required ? "NORMALIZATION_REQUIRED" : "COMPILED") : "LEGACY_UNBOUND",
    candidates: state.candidates,
    reviews: state.reviews,
    pr_binding: state.pr_binding ?? null,
    pr_bindings: state.pr_bindings ?? {},
    merges: state.merges ?? {},
    ci_evidence: state.ci_evidence ?? {},
    merge: state.merge ?? null,
    checkpoint: state.checkpoint,
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
// Observations can recur after a change (CI SUCCESS -> FAILURE -> SUCCESS,
// or a new blocker after clearing one). Reuse only the latest applicable event;
// select and commit under the same lease/revision so concurrent changes fail CAS.
async function commitObservation(controller, holder, prefix, type, body, matches, active = () => true) {
  const lease = await controller.acquire(holder)
  const snap = await controller.snapshot()
  if (type === "BLOCK" && snap.state.blocker &&
      (snap.state.blocker.class !== body.class || snap.state.blocker.reason !== body.reason)) {
    throw new Error("BLOCK: an active blocker cannot be replaced; resolve it through clear_blocker when permitted.")
  }
  const prior = snap.events.findLast(event => event.operation_type === type && matches(event.body))
  const replay = prior && active(snap.state) && stableHash(prior.body) === stableHash(body)
  const operation_id = replay ? prior.operation_id : `${prefix}:${snap.state.revision}:${stableHash(body)}`
  return controller.commit({ operation_id, operation_type: type, body }, {
    holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token,
  })
}

async function commitAction(controller, holder, operation_id, operation_type, body) {
  const lease = await controller.acquire(holder)
  const snap = await controller.snapshot()
  const res = await controller.commit(
    { operation_id, operation_type, body },
    { holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token },
  )
  return res
}

// Internal (non-MCP) launch-claim boundary used by the runtime at
// ctx.tool.hook("execute.before"): after the turn-guard admits a subagent launch
// for a bound, claim_required dispatch, durably record the claim BEFORE OpenCode
// executes the subagent. The deterministic operation identity (execution_id +
// dispatch_id + call_id) makes a retry a replay (idempotent); a different tool
// call for an already-claimed dispatch is rejected by the state machine, which
// never overwrites launch_call_id.
export async function claimDispatchLaunch(projectRoot, { execution_id, dispatch_id, call_id, session_id }) {
  const executionId = sanitizeId(execution_id, "execution_id")
  const dir = join(projectRoot, ".harness", "execution", "controller", executionId)
  const controller = await createExecutionController({ dir, lease_ttl_ms: 30000 })
  const holder = String(session_id)
  const operation_id = `${executionId}:claim:${dispatch_id}:${call_id}`
  const lease = await controller.acquire(holder)
  const snap = await controller.snapshot()
  const res = await controller.commit(
    { operation_id, operation_type: "DISPATCH_LAUNCH_CLAIM", body: { dispatch_id, call_id } },
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
    const mandateId = String(input.mandate_id ?? `${executionId}-MANDATE-001`)
    if (epic.mandate.wu_sequence?.length) {
      await verifyDeclaredWorkUnits(projectRoot, epic, epic.mandate.wu_sequence)
    }
    const body = {
      execution_id: `${executionId}:exec`,
      mandate_id: mandateId,
      mandate_revision: epic.source_revision,
      max_wus: epic.mandate.max_wus,
      total_seconds: epic.mandate.total_seconds,
      merge_policy: epic.mandate.merge_policy ?? "none",
      required_ci_checks: epic.mandate.required_ci_checks ?? [],
      authority_kind: MANDATE_AUTHORITY.OWNER_APPROVED_EPIC,
      source_artifact_id: epic.source_id,
      source_record_key: epic.record_key,
      source_hash: epic.sha256,
      ...(epic.mandate.wu_sequence?.length ? { wu_sequence: epic.mandate.wu_sequence } : {}),
    }
    const res = await commitAction(controller, holder, `${executionId}:mandate`, "MANDATE_APPROVE", body)
    return { action, commit_status: res.status, source_artifact_id: epic.source_id, source_hash: epic.sha256, ...(await summary(controller)) }
  }

  if (action === "amend_mandate") {
    const epicArtifactId = String(input.epic_artifact_id ?? "")
    if (!epicArtifactId) throw new Error("amend_mandate requires epic_artifact_id (an APPROVED Epic artifact in the knowledge index).")
    const epic = await findApprovedEpic(projectRoot, epicArtifactId)
    const lease = await controller.acquire(holder)
    const snap = await controller.snapshot()
    const current = snap.state.mandate
    if (!current) throw new Error("amend_mandate requires an existing approved mandate.")
    if (current.authority_kind !== MANDATE_AUTHORITY.OWNER_APPROVED_EPIC) {
      throw new Error("amend_mandate requires an OWNER_APPROVED_EPIC mandate.")
    }

    const operationId = `${executionId}:mandate-amend:${epic.source_id}:${epic.sha256}`
    const existing = snap.events.find((event) => event.operation_id === operationId)
    if (existing) {
      const replay = await controller.commit(
        { operation_id: operationId, operation_type: "MANDATE_AMEND", body: existing.body },
        { holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token },
      )
      return {
        action,
        commit_status: replay.status,
        amendment_receipt: {
          operation_id: operationId,
          source_artifact_id: existing.body.source_artifact_id,
          source_hash: existing.body.source_hash,
          previous: {
            merge_policy: existing.body.expected_merge_policy,
            required_ci_checks: existing.body.expected_required_ci_checks ?? [],
          },
          effective: {
            merge_policy: replay.state.mandate.merge_policy,
            required_ci_checks: replay.state.mandate.required_ci_checks,
            policy_revision: replay.state.mandate.policy_revision ?? null,
            policy_source_artifact_id: replay.state.mandate.policy_source_artifact_id ?? null,
            policy_source_hash: replay.state.mandate.policy_source_hash ?? null,
          },
        },
        ...(await summary(controller)),
      }
    }

    if (snap.state.completed) throw new Error("amend_mandate cannot modify a completed execution.")
    if (snap.state.merge) throw new Error("amend_mandate cannot modify policy after a merge has started or been recorded.")
    if (epic.mandate.max_wus !== current.max_wus) {
      throw new Error(`amend_mandate refuses scope change: max_wus ${current.max_wus} -> ${epic.mandate.max_wus}.`)
    }
    if (epic.mandate.total_seconds !== snap.state.budget.total_seconds) {
      throw new Error(`amend_mandate refuses budget change: total_seconds ${snap.state.budget.total_seconds} -> ${epic.mandate.total_seconds}.`)
    }

    const previous = {
      merge_policy: current.merge_policy ?? "none",
      required_ci_checks: [...(current.required_ci_checks ?? [])],
      policy_source_artifact_id: current.policy_source_artifact_id ?? current.source_artifact_id ?? null,
      policy_source_hash: current.policy_source_hash ?? current.source_hash ?? null,
    }
    const body = {
      mandate_id: current.mandate_id,
      max_wus: current.max_wus,
      total_seconds: snap.state.budget.total_seconds,
      expected_merge_policy: previous.merge_policy,
      expected_required_ci_checks: previous.required_ci_checks,
      merge_policy: epic.mandate.merge_policy ?? "none",
      required_ci_checks: epic.mandate.required_ci_checks ?? [],
      source_artifact_id: epic.source_id,
      source_record_key: epic.record_key,
      source_hash: epic.sha256,
      source_revision: epic.source_revision,
    }
    const res = await controller.commit(
      { operation_id: operationId, operation_type: "MANDATE_AMEND", body },
      { holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token },
    )
    return {
      action,
      commit_status: res.status,
      amendment_receipt: {
        operation_id: operationId,
        source_artifact_id: epic.source_id,
        source_hash: epic.sha256,
        previous,
        effective: {
          merge_policy: res.state.mandate.merge_policy,
          required_ci_checks: res.state.mandate.required_ci_checks,
          policy_revision: res.state.mandate.policy_revision ?? null,
          policy_source_artifact_id: res.state.mandate.policy_source_artifact_id ?? null,
          policy_source_hash: res.state.mandate.policy_source_hash ?? null,
        },
      },
      ...(await summary(controller)),
    }
  }

  if (action === "resolve_authority_blocker") {
    const authority = await findApprovedAuthorityResolution(projectRoot, String(input.decision_artifact_id ?? ""))
    if (authority.resolution.execution_id !== executionId) throw new Error("Authority resolution execution_id mismatch")
    const body = { ...authority.resolution, decision_content: authority.decision_content,
      source_artifact_id: authority.source_artifact_id, source_record_key: authority.source_record_key, source_hash: authority.source_hash }
    const res = await commitAction(controller, holder,
      `${executionId}:authority-resolution:${authority.source_record_key}`, "AUTHORITY_RESOLVE", body)
    return { action, commit_status: res.status, authority_resolution_receipt: body, ...(await summary(controller)) }
  }

  if (action === "amend_wu_budget") {
    const authority = await findApprovedWuBudgetAmendment(projectRoot, String(input.decision_artifact_id ?? ""))
    if (authority.amendment.execution_id !== executionId) throw new Error("WU budget amendment execution_id mismatch")
    const body = { ...authority.amendment, source_artifact_id: authority.source_artifact_id,
      source_record_key: authority.source_record_key, source_hash: authority.source_hash }
    const res = await commitAction(controller, holder,
      `${executionId}:wu-budget:${authority.source_record_key}`, "WU_BUDGET_AMEND", body)
    return { action, commit_status: res.status, amendment_receipt: body, ...(await summary(controller)) }
  }

  if (action === "bind_wu_contract") {
    const snap = await controller.snapshot()
    const wu = snap.state.wu
    if (!wu || wu.completed) throw new Error("bind_wu_contract requires an active WU")
    const contract = compileWuContract(wu.wu_id, await readWorkUnitDefinition(projectRoot, wu.wu_id,
      snap.state.mandate.source_artifact_id, input.wu_artifact_id ?? wu.wu_id))
    if (contract.normalization_required) throw new Error("Normalize the existing WU verification criteria into execution_contract before binding")
    const res = await commitAction(controller, holder, `${executionId}:wu-contract:${contract.contract_hash}`, "WU_CONTRACT_BIND", { contract })
    return { action, commit_status: res.status, ...(await summary(controller)) }
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
    const priorActivation = snap.events.find(e => e.operation_id === `${executionId}:activate:${wuId}`)
    if (priorActivation && priorActivation.body.mandate_id === mandateId &&
        (!input.wu_artifact_id || input.wu_artifact_id === priorActivation.body.contract?.source_record_key)) {
      return { action, commit_status: "replayed", wu_id: wuId, ...(await summary(controller)) }
    }
    // Validate lifecycle first, before loading a successor that is not yet eligible.
    applyEvent(snap.state, { operation_type: "WU_ACTIVATE", body: { wu_id: wuId, mandate_id: mandateId }, next_revision: snap.state.revision + 1 })
    const contract = compileWuContract(wuId, await readWorkUnitDefinition(projectRoot, wuId, snap.state.mandate.source_artifact_id, input.wu_artifact_id ?? wuId))
    const res = await commitAction(controller, holder, `${executionId}:activate:${wuId}`, "WU_ACTIVATE", { wu_id: wuId, mandate_id: mandateId, contract })
    return { action, commit_status: res.status, wu_id: wuId, ...(await summary(controller)) }
  }

  if (action === "status") {
    return { action, ...(await summary(controller)) }
  }

  if (action === "reserve") {
    const dispatchId = requireDispatchId(input)
    const current = (await controller.snapshot()).state
    if (current.wu?.contract?.normalization_required) throw new Error("Normalize/bind the existing WU verification contract before reserving work; no budget has been spent")
    const reserved = Number(input.reserved_seconds)
    if (!Number.isFinite(reserved) || reserved < 0) throw new Error("reserve requires a finite non-negative reserved_seconds.")
    const res = await commitAction(controller, holder, `${executionId}:reserve:${dispatchId}`, "DISPATCH_RESERVE", { dispatch_id: dispatchId, reserved_seconds: reserved })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "prepare_launch") {
    const dispatchId = requireDispatchId(input)
    const body = { dispatch_id: dispatchId }
    // Wave B launch-intent binding: when the orchestrator names the agent it is
    // about to launch, the dispatch records who prepared it and what agent is
    // expected. claim_required makes DISPATCH_LAUNCH require a prior
    // DISPATCH_LAUNCH_CLAIM (the runtime writes it at the execute.before
    // boundary). Omitting launch_agent keeps V1 backward-compatible behavior.
    if (input.launch_agent) {
      body.prepared_by_session_id = holder
      body.expected_agent = String(input.launch_agent)
      body.claim_required = true
    }
    const res = await commitAction(controller, holder, `${executionId}:prepare:${dispatchId}`, "DISPATCH_PREPARE", body)
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "record_launch") {
    const dispatchId = requireDispatchId(input)
    const launchSessionId = String(input.launch_session_id ?? "")
    if (!launchSessionId) throw new Error("record_launch requires launch_session_id (the external identity persisted at launch).")
    // Automatic runtime capture may have already bound this exact identity.
    const existing = (await controller.snapshot()).state.dispatches[dispatchId]
    if (existing?.session_id) {
      if (existing.session_id !== launchSessionId) throw new Error("record_launch conflicts with the recorded child session identity.")
      return { action, commit_status: "already_recorded", dispatch_id: dispatchId, ...(await summary(controller)) }
    }
    const res = await commitAction(controller, holder, `${executionId}:launch:${dispatchId}`, "DISPATCH_LAUNCH", { dispatch_id: dispatchId, session_id: launchSessionId })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "mark_ambiguous") {
    const dispatchId = requireDispatchId(input)
    const res = await commitAction(controller, holder, `${executionId}:ambiguous:${dispatchId}`, "DISPATCH_MARK_AMBIGUOUS", { dispatch_id: dispatchId })
    return { action, commit_status: res.status, dispatch_id: dispatchId, ...(await summary(controller)) }
  }

  if (action === "resolve_ambiguous_launch") {
    const dispatchId = requireDispatchId(input)
    const launchSessionId = String(input.launch_session_id ?? "")
    if (!launchSessionId) throw new Error("resolve_ambiguous_launch requires launch_session_id (the independently recovered external session identity).")
    const recoveryEvidence = String(input.recovery_evidence ?? "")
    if (!recoveryEvidence.trim()) throw new Error("resolve_ambiguous_launch requires recovery_evidence describing how the exact session identity was established.")
    const operationId = `${executionId}:resolve-ambiguous-launch:${dispatchId}:${launchSessionId}`
    const res = await commitAction(controller, holder, operationId, "DISPATCH_RESOLVE_AMBIGUOUS_LAUNCH", {
      dispatch_id: dispatchId,
      session_id: launchSessionId,
      recovery_evidence: recoveryEvidence,
    })
    return {
      action,
      commit_status: res.status,
      dispatch_id: dispatchId,
      launch_session_id: launchSessionId,
      ...(await summary(controller)),
    }
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
    if (snap.state.wu.contract) {
      const effective = snap.state.wu.contract
      if (!effective.verification_contract_hash) throw new Error("WU verification contract requires normalization before freezing; retain the approved source criteria.")
      if (candidate.manifest?.verification_contract?.contract_hash !== effective.verification_contract_hash)
        throw new Error("Candidate verification contract differs from the active WU contract")
    }
    const requiredCheckIds = (candidate.verification_contract?.commands ?? []).map((check) => check.id)
    const contractHash = candidate.manifest?.verification_contract?.contract_hash ?? null
    const res = await controller.commit(
      { operation_id: `${executionId}:candidate:${candidateId}`, operation_type: "FREEZE_CANDIDATE", body: { candidate_id: candidateId, wu_id: wuId, manifest_hash: candidate.manifest_hash, tree_hash: candidate.tree_hash, manifest: candidate.manifest ?? null, verification_contract_hash: contractHash, required_check_ids: requiredCheckIds, wu_contract_hash: snap.state.wu.contract?.contract_hash ?? null } },
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
    for (const evidenceId of evidenceIds) {
      const receipt = await readVerificationReceipt(receiptsDir, evidenceId)
      if (!receipt) throw new Error(`record_review: evidence ${evidenceId} not found.`)
      if (receipt.candidate_id !== candidateId) throw new Error(`record_review: evidence ${evidenceId} belongs to ${receipt.candidate_id}, not ${candidateId}.`)
      if (contractHash !== null && receipt.verification_contract_hash !== contractHash) throw new Error(`record_review: evidence ${evidenceId} contract hash ${receipt.verification_contract_hash} does not match candidate contract ${contractHash}.`)
      if (receipt.status !== "PASS" && receipt.status !== "FAIL") throw new Error(`record_review: evidence ${evidenceId} status is ${receipt.status}, not a run result.`)
      if (verdict === "PASS" && receipt.status !== "PASS") throw new Error(`record_review: PASS verdict requires all-PASS evidence; ${evidenceId} is ${receipt.status}.`)
      verifiedCheckIds.push(receipt.check_id)
    }
    const res = await controller.commit(
      { operation_id: `${executionId}:review:${candidateId}:${stableHash({ verdict, evidenceIds, reviewer: input.reviewer ?? null })}`, operation_type: "RECORD_REVIEW", body: { candidate_id: candidateId, verdict, candidate_hashes: { manifest_hash: frozenCandidate.manifest_hash, tree_hash: frozenCandidate.tree_hash }, reviewer: input.reviewer ?? null, verification_evidence_ids: evidenceIds, verification_contract_hash: contractHash, verified_check_ids: verifiedCheckIds } },
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
    const reason = String(input.reason ?? "")
    if (!reason) throw new Error("block requires reason (a human-readable explanation of the stop).")
    const res = await commitObservation(controller, holder, `${executionId}:block`, "BLOCK", { class: cls, reason }, () => true, state => Boolean(state.blocker))
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "clear_blocker") {
    const resolution = String(input.resolution ?? "")
    if (!resolution.trim()) throw new Error("clear_blocker requires resolution.")
    const lease = await controller.acquire(holder)
    const snap = await controller.snapshot()
    const blocker = snap.state.blocker
    if (!blocker) {
      const prior = snap.state.last_blocker_resolution
      if (prior && prior.resolution === resolution) {
        const operationId = `${executionId}:clear-blocker:${prior.blocked_at_revision}`
        const existing = snap.events.find((event) => event.operation_id === operationId)
        if (existing) {
          const replay = await controller.commit(
            { operation_id: operationId, operation_type: "CLEAR_BLOCKER", body: existing.body },
            { holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token },
          )
          return {
            action,
            commit_status: replay.status,
            blocker_resolution_receipt: {
              operation_id: operationId,
              class: existing.body.blocker_class,
              blocked_at_revision: existing.body.blocked_at_revision,
              resolution: existing.body.resolution,
            },
            ...(await summary(controller)),
          }
        }
      }
      throw new Error("clear_blocker requires an active blocker.")
    }
    if (!RECOVERABLE_BLOCKER_CLASSES.has(blocker.class)) {
      if (blocker.class === "BLOCKED_AUTHORITY") throw new Error("clear_blocker cannot clear non-recoverable blocker BLOCKED_AUTHORITY. Use resolve_authority_blocker with the exact owner-approved decision; no renewed approval is needed when already granted.")
      throw new Error(`clear_blocker cannot clear non-recoverable blocker ${blocker.class}.${blocker.class === "BUDGET_EXHAUSTED" ? " For an owner-approved WU allocation within the existing Epic total, use amend_wu_budget with decision_artifact_id." : ""}`)
    }
    const operationId = `${executionId}:clear-blocker:${blocker.at_revision}`
    const res = await controller.commit(
      {
        operation_id: operationId,
        operation_type: "CLEAR_BLOCKER",
        body: {
          blocker_class: blocker.class,
          blocked_at_revision: blocker.at_revision,
          resolution,
        },
      },
      { holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token },
    )
    return {
      action,
      commit_status: res.status,
      blocker_resolution_receipt: {
        operation_id: operationId,
        class: blocker.class,
        blocked_at_revision: blocker.at_revision,
        resolution,
      },
      ...(await summary(controller)),
    }
  }

  if (action === "bind_pr") {
    const res = await commitAction(controller, holder, `${executionId}:bind-pr:${stableHash({ candidate_id: input.candidate_id, repository: input.repository, pr_number: input.pr_number, head_sha: input.head_sha, base_sha: input.base_sha, base_branch: input.base_branch })}`, "BIND_PR", {
      repository: String(input.repository ?? ""),
      pr_number: Number(input.pr_number),
      candidate_id: String(input.candidate_id ?? ""),
      head_sha: String(input.head_sha ?? ""),
      base_branch: String(input.base_branch ?? ""),
      base_sha: String(input.base_sha ?? ""),
    })
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "record_ci") {
    const binding = (await controller.snapshot()).state.pr_binding
    const res = await commitObservation(controller, holder, `${executionId}:record-ci`, "RECORD_CI", {
      candidate_id: String(input.candidate_id ?? ""),
      head_sha: String(input.head_sha ?? ""),
      check_identity: String(input.check_identity ?? ""),
      conclusion: String(input.conclusion ?? ""),
      evidence_ref: input.evidence_ref ?? null,
      binding_at_revision: binding?.candidate_id === input.candidate_id ? binding.at_revision : null,
    }, body => body.candidate_id === String(input.candidate_id ?? "") && body.check_identity === String(input.check_identity ?? ""))
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "complete") {
    const res = await commitAction(controller, holder, `${executionId}:complete`, "COMPLETE", { result: input.result ?? null })
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "reconcile") {
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

function requireDispatchId(input) {
  const id = String(input.dispatch_id ?? "")
  if (!id) throw new Error("This action requires dispatch_id.")
  return id
}
