import { summary, verify, auditRecovery } from "./controller-inspection.js"
import { prepareReviewEvidence } from "./review-evidence.js"
import { inspectAcceptanceCoverage } from "./acceptance-coverage.js"
import { readLog, validateLog } from "./event-log.js"
import { project } from "./state.js"
import { projectOperationalView } from "./operational-view.js"
import { processReviewAttestation, applicableAuthority, blockerFingerprint, activeRecovery } from "./process-recovery.js"
import { validateControllerPreflight } from "./controller-preflight.js"
import { PLANNING_ESTIMATES } from "./time-policy.js"
import { deriveVerificationCorrection, correctionCheckMapping } from "./contract-correction.js"
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
import { validateContractCorrection } from "./contract-correction.js"
import { assertTrustedReviewHandoff } from "./review-handoff.js"
import { inspectRepairBundle } from "./repair-plan.js"
import { inspectStaleWorktreeScope, isStaleWorktreeScopeBlocker, classifyScopeBlocker } from "./scope-recovery.js"
import { verifyScopeCheckoutRoots } from "./scope-checkout.js"
import { compileMandateDerivedWu, inspectMandateDerivedWu, isTechnicalWuContractBlocker } from "./jit-contract.js"
import { inspectAuthorityGap } from "./authority-triage.js"
import { wuBudgetUsage } from "./wu-budget.js"
import { stableHash } from "./serialize.js"
import { applyEvent } from "./state.js"
import { createExecutionController } from "./execution.js"
import { createCandidateRegistry } from "./candidate-registry.js"
import { readVerificationReceipt } from "./verification-results.js"
import { findApprovedProcessPolicy, findApprovedTimePolicy, findApprovedEpic, findApprovedWuBudgetAmendment, findApprovedAuthorityResolution, verifyDeclaredWorkUnits, readWorkUnitDefinition } from "../project-knowledge.js"
import { DISPATCH_STATUS, RESERVATION_STATUS, MANDATE_AUTHORITY, RECOVERABLE_BLOCKER_CLASSES } from "./constants.js"

function sanitizeId(raw, label) {
  const value = String(raw ?? "")
  const id = value.replace(/[^A-Za-z0-9._-]/g, "_")
  if (!id || id === "." || id === "..") throw new Error(`${label} must be a non-empty identifier that is not '.' or '..'.`)
  return id
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

export async function runExecutionController(projectRoot, input, candidateRegistry, options = {}) {
  validateControllerPreflight(input)
  const executionId = sanitizeId(input.execution_id, "execution_id")
  const dir = join(projectRoot, ".harness", "execution", "controller", executionId)
  const action = String(input.action ?? "status")
  if (action === "prepare_review_evidence") {
    // Bypass controller construction and its mutex/lease path: this call
    // reads only an existing journal and immutable verification receipts.
    const events = validateLog(await readLog(join(dir, "events.ndjson")))
    if (!events.length) return { action, status: "EXECUTION_NOT_FOUND", execution_id: executionId, ready_for_review: false }
    const state = project(events)
    return { action, ...(await prepareReviewEvidence(projectRoot, state, {
      execution_id: executionId, wu_id: String(input.wu_id ?? ""),
      candidate_id: String(input.candidate_id ?? ""),
      verification_evidence_ids: input.verification_evidence_ids ?? [],
    })) }
  }
  const controller = await createExecutionController({ dir, lease_ttl_ms: 30000 })
  const registry = candidateRegistry ?? createCandidateRegistry({ dir: join(projectRoot, ".harness", "execution") })
  const holder = String(input.session_id ?? `controller:${executionId}`)

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
    const priorApproval = (await controller.snapshot()).events.find(e => e.operation_id === `${executionId}:mandate`)
    const body = {
      ...(!priorApproval || priorApproval.body.time_policy ? { time_policy: priorApproval?.body.time_policy ?? PLANNING_ESTIMATES } : {}),
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

  if (action === "adopt_process_policy") {
    const a = await findApprovedProcessPolicy(projectRoot, String(input.decision_artifact_id ?? ""))
    if (a.resolution.execution_id !== executionId) throw new Error("Process policy execution mismatch")
    const res = await commitAction(controller, holder, `${executionId}:process-policy:${a.source_record_key}`, "PROCESS_POLICY_ADOPT",
      { policy: a.resolution, decision_content: a.decision_content, source_artifact_id: a.source_artifact_id, source_record_key: a.source_record_key, source_hash: a.source_hash })
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }
  if (action === "start_process_recovery") {
    const { state, events } = await controller.snapshot()
    const id = `${executionId}:process-recovery:${state.wu?.wu_id}`
    const previous = events.find(e => e.operation_id === id)
    const body = previous?.body ?? { wu_id: state.wu?.wu_id, kind: input.process_kind, reason: input.reason,
      evidence_ref: input.evidence_ref, blocked_at_revision: state.blocker?.at_revision ?? null }
    if (previous && (body.kind !== input.process_kind || body.reason !== input.reason || body.evidence_ref !== input.evidence_ref)) throw new Error("Process recovery retry changed content")
    const res = await commitAction(controller, holder, id, "PROCESS_RECOVERY_START", body)
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }
  if (["record_process_evidence", "record_red"].includes(action)) {
    const snap = await controller.snapshot()
    if (!/^verify-[a-f0-9]{64}$/.test(input.evidence_id ?? "")) throw new Error("Invalid process evidence receipt ID")
    const receipt = await readVerificationReceipt(join(projectRoot, ".harness/execution/verification-results"), String(input.evidence_id ?? ""))
    if (!receipt || receipt.status !== "FAIL" || receipt.evidence_version !== 2 || receipt.exit_code === 0 || receipt.exit_code === null ||
        receipt.output.timed_out || receipt.output.aborted || receipt.output.setup_results.some(r => !r.ok)) throw new Error("Executed negative check required; setup failures/timeouts/cancellation are not process evidence")
    const candidate = await registry.load(receipt.candidate_id)
    if (!candidate || !candidate.verification_contract?.commands?.some(check => check.id === receipt.check_id) || candidate.verification_contract?.source_wu_id !== snap.state.wu?.wu_id ||
        receipt.verification_contract_hash !== snap.state.wu?.contract?.verification_contract_hash ||
        candidate.manifest?.verification_contract?.contract_hash !== receipt.verification_contract_hash) throw new Error("Negative evidence must match active WU/check contract")
    const body = { wu_id: snap.state.wu.wu_id, candidate_id: candidate.candidate_id, tree_hash: candidate.tree_hash,
      ...(action === "record_process_evidence" ? { method: input.method, invariant: input.invariant } : {}), receipt }
    const type = action === "record_red" ? "PROCESS_RED_RECORD" : "PROCESS_EVIDENCE"
    const res = await commitAction(controller, holder, `${executionId}:${type}:${receipt.evidence_id}`, type, body)
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }
  if (action === "record_process_review") {
    const { state } = await controller.snapshot()
    const recovery = activeRecovery(state)
    const dispatch = state.dispatches[input.review_dispatch_id]
    if (!recovery || !dispatch?.handoff) throw new Error("Process recovery and independent reviewer handoff required")
    const attestation = processReviewAttestation(dispatch)
    const body = { candidate_id: attestation.candidate_id, review_dispatch_id: input.review_dispatch_id,
      assessment: attestation.assessment, evidence_ids: attestation.evidence_ids, handoff_hash: dispatch.handoff.content_hash }
    const res = await commitAction(controller, holder, `${executionId}:process-review:${stableHash(body)}`, "PROCESS_REVIEW", body)
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "adopt_planning_estimates") {
    const authority = await findApprovedTimePolicy(projectRoot, String(input.decision_artifact_id ?? ""))
    if (authority.resolution.execution_id !== executionId) throw new Error("Time policy execution_id mismatch")
    const body = { ...authority.resolution, decision_content: authority.decision_content,
      source_artifact_id: authority.source_artifact_id, source_record_key: authority.source_record_key, source_hash: authority.source_hash }
    const res = await commitAction(controller, holder, `${executionId}:time-policy:${authority.source_record_key}`, "TIME_POLICY_ADOPT", body)
    return { action, commit_status: res.status, ...(await summary(controller)) }
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

  if (action === "inspect_repair_bundle") {
    const { state } = await controller.snapshot()
    const result = inspectRepairBundle(state, String(input.review_dispatch_id ?? ""), String(input.candidate_id ?? ""))
    return { action, revision: state.revision, ...result }
  }
  if (action === "correct_verification_contract" || action === "inspect_verification_correction") {
    const snap = await controller.snapshot(), wu = snap.state.wu
    if (!wu || wu.completed) throw new Error("Contract correction requires an active WU")
    if (!input.wu_artifact_id) throw new Error("Select the exact approved corrected WU artifact")
    let definition
    try { definition = await readWorkUnitDefinition(projectRoot, wu.wu_id, snap.state.mandate.source_artifact_id, input.wu_artifact_id, { requireApproved: true }) }
    catch (error) {
      if (!snap.state.process_policy?.policy?.technical_verification) throw error
      definition = await readWorkUnitDefinition(projectRoot, wu.wu_id, snap.state.mandate.source_artifact_id, input.wu_artifact_id, { requireProposed: true })
      definition.source_authority = "DELEGATED_TECHNICAL"
    }
    let proposal = compileWuContract(wu.wu_id, definition)
    if (definition.source_authority === "DELEGATED_TECHNICAL") {
      const { contract_hash, ...unsigned } = proposal
      const delegated = { ...unsigned, source_authority: "DELEGATED_TECHNICAL", policy_source_hash: snap.state.process_policy.source_hash }
      proposal = { ...delegated, contract_hash: stableHash(delegated) }
    }
    const operation = `${executionId}:verification-correction:${input.expected_contract_hash}:${proposal.contract_hash}`
    const previous = snap.events.find(e => e.operation_id === operation)
    const baseline = previous ? snap.state.contract_corrections.find(c =>
      c.expected_contract_hash === input.expected_contract_hash && c.contract.contract_hash === previous.body.contract.contract_hash)?.previous_contract : wu.contract
    if (!baseline) throw new Error("Correction history baseline missing")
    const contract = deriveVerificationCorrection(baseline, proposal)
    const body = { mode: "verification_only", contract, expected_contract_hash: input.expected_contract_hash, reason: input.reason,
      check_mapping: correctionCheckMapping(baseline.verification_contract, contract.verification_contract, input.check_mapping) }
    if (action === "inspect_verification_correction") {
      validateContractCorrection(snap.state, body)
      return { action, status: "ADMISSIBLE_READ_ONLY", revision: snap.state.revision,
        wu_id: wu.wu_id, original_contract_hash: baseline.contract_hash,
        proposed_contract_hash: contract.contract_hash, required_check_mapping: body.check_mapping,
        next_action: "Use correct_verification_contract with this exact already-approved source when appropriate." }
    }
    const res = await commitAction(controller, holder, operation, "WU_CONTRACT_CORRECT", body)
    return { action, commit_status: res.status, next_action: "Clear only the resolved tooling blocker, refreeze the same code with the corrected contract, rerun every check and fresh independent review. Prior receipts remain historical.", ...(await summary(controller)) }
  }

  if (action === "inspect_authority_gap") {
    const snap = await controller.snapshot()
    return { action, revision: snap.state.revision, ...inspectAuthorityGap(snap.state) }
  }

  if (action === "inspect_next_wu_contract") {
    // Read-only source-backed preflight. Incomplete planning fields are not
    // new budget authority questions; the JIT compiler determines readiness.
    const { state } = await controller.snapshot()
    const next = state.mandate?.wu_sequence?.[state.activated_wu_ids.length] ?? null
    if (!next) return { action, status: "NO_NEXT_FROZEN_WU", revision: state.revision }
    if (state.wu && !state.wu.completed) return { action, status: "PREDECESSOR_INCOMPLETE",
      next_wu_id: next, active_wu_id: state.wu.wu_id, revision: state.revision }
    if (state.staged_wu_contract) return { action, status: "APPROVED_CONTRACT_STAGED",
      next_wu_id: next, source_record_key: state.staged_wu_contract.contract.source_record_key,
      contract_hash: state.staged_wu_contract.contract.contract_hash, revision: state.revision }
    if (state.blocker && !isTechnicalWuContractBlocker(state.blocker)) {
      return { action, status: "AUTHORITY_OR_SAFETY_BLOCKED", next_wu_id: next,
        blocker_class: state.blocker.class, authority_question: state.blocker.authority_question ?? null,
        revision: state.revision, note: "Do not replace a real business/security/permission stop with JIT" }
    }
    const sourceId = String(input.wu_artifact_id ?? next)
    try {
      const definition = await readWorkUnitDefinition(projectRoot, next,
        state.mandate.source_artifact_id, sourceId, { allowPlanningDrift: true })
      if (!/^execution_contract: /m.test(definition.content)) {
        const diagnosis = await inspectMandateDerivedWu(projectRoot, state, next, definition)
        return { action, ...diagnosis, next_wu_id: next, revision: state.revision,
          next_action: diagnosis.status === "READY_FOR_JIT" ? "derive_and_stage_next_wu_contract" : null }
      }
      const contract = compileWuContract(next, definition)
      return { action, status: contract.normalization_required ? "NORMALIZATION_REQUIRED" : "EXECUTABLE_SOURCE_READY",
        next_wu_id: next, source_record_key: contract.source_record_key,
        contract_hash: contract.contract_hash, verification_contract_hash: contract.verification_contract_hash,
        acceptance_coverage: inspectAcceptanceCoverage(contract.verification_contract),
        revision: state.revision,
        note: "Read-only source inspection; executable status is not approval or activation authority" }
    } catch (error) {
      return { action, status: "SOURCE_NORMALIZATION_OR_SELECTION_REQUIRED", next_wu_id: next,
        reason: error.message, revision: state.revision }
    }
  }

  if (action === "derive_and_stage_next_wu_contract") {
    // The frozen Epic, not a fabricated per-WU APPROVED label, authorizes
    // technical normalization of exactly the next predeclared DRAFT.
    const wuId = String(input.wu_id ?? "")
    const sourceId = String(input.wu_artifact_id ?? "")
    if (!wuId || !sourceId || !Number.isSafeInteger(input.expected_revision)) {
      throw new Error("JIT requires wu_id, exact source and expected_revision")
    }
    const snap = await controller.snapshot()
    const previous = snap.events.find(e => e.operation_type === "WU_CONTRACT_STAGE" &&
      e.body.wu_id === wuId && e.body.source_artifact_id === sourceId && e.body.derived_technical === true)
    if (previous) {
      if (previous.body.expected_revision !== input.expected_revision) throw new Error("JIT replay revision mismatch")
      const res = await commitAction(controller, holder, previous.operation_id, "WU_CONTRACT_STAGE", previous.body)
      return { action, commit_status: res.status, ...(await summary(controller)) }
    }
    if (snap.state.revision !== input.expected_revision) throw new Error("JIT stale revision")
    if (snap.state.mandate?.authority_kind !== MANDATE_AUTHORITY.OWNER_APPROVED_EPIC) throw new Error("JIT requires an owner-approved Epic")
    if (snap.state.blocker && !isTechnicalWuContractBlocker(snap.state.blocker)) throw new Error("JIT refuses unrelated authority or security blockers")
    if (snap.state.staged_wu_contract) throw new Error("JIT contract already staged")
    if (snap.state.mandate.wu_sequence?.[snap.state.activated_wu_ids.length] !== wuId ||
        (snap.state.wu && !snap.state.wu.completed)) throw new Error("JIT_WU_ORDER: next frozen WU with completed predecessor required")
    const source = await readWorkUnitDefinition(projectRoot, wuId, snap.state.mandate.source_artifact_id, sourceId,
      { allowPlanningDrift: true })
    const contract = await compileMandateDerivedWu(projectRoot, snap.state, wuId, source)
    const body = { wu_id: wuId, source_artifact_id: sourceId, expected_revision: snap.state.revision,
      derived_technical: true, blocker_at_revision: snap.state.blocker?.at_revision ?? null, contract }
    const res = await commitAction(controller, holder,
      `${executionId}:jit-wu-stage:${wuId}:${contract.contract_hash}`, "WU_CONTRACT_STAGE", body)
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "stage_wu_contract") {
    // This is an audited recovery/selection operation, not WU activation.
    // It may run while BLOCKED_AUTHORITY prevents WU_ACTIVATE; all source
    // authority comes from the exact indexed APPROVED WU revision.
    const wuId = String(input.wu_id ?? "")
    const sourceId = String(input.wu_artifact_id ?? "")
    if (!wuId || !sourceId) throw new Error("stage_wu_contract requires wu_id and exact approved wu_artifact_id")
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) {
      throw new Error("stage_wu_contract requires expected_revision from the durable status")
    }
    const snap = await controller.snapshot()
    const previous = snap.events.find(e => e.operation_type === "WU_CONTRACT_STAGE" &&
      e.body.wu_id === wuId && (e.body.source_artifact_id === sourceId || e.body.contract.source_record_key === sourceId))
    if (!previous && snap.state.revision !== input.expected_revision) {
      throw new Error(`stage_wu_contract stale revision: expected ${input.expected_revision}, current ${snap.state.revision}`)
    }
    if (snap.state.mandate?.authority_kind !== MANDATE_AUTHORITY.OWNER_APPROVED_EPIC) {
      throw new Error("stage_wu_contract requires an owner-approved mandate")
    }
    if (!previous && snap.state.mandate.wu_sequence?.[snap.state.activated_wu_ids.length] !== wuId) {
      throw new Error("stage_wu_contract must target the next frozen WU")
    }
    const source = await readWorkUnitDefinition(projectRoot, wuId, snap.state.mandate.source_artifact_id,
      sourceId, { requireApproved: true })
    const contract = compileWuContract(wuId, source)
    if (contract.normalization_required) {
      throw new Error("stage_wu_contract rejects a non-executable source without a complete verification contract")
    }
    if (previous) {
      if (previous.body.expected_revision !== input.expected_revision ||
        previous.body.contract.contract_hash !== contract.contract_hash) {
        throw new Error("stage_wu_contract replay conflicts with the previous approved source or revision")
      }
      const replay = await commitAction(controller, holder, previous.operation_id, "WU_CONTRACT_STAGE", previous.body)
      return { action, commit_status: replay.status, ...(await summary(controller)) }
    }
    const body = { wu_id: wuId, source_artifact_id: sourceId, expected_revision: input.expected_revision, contract }
    const res = await commitAction(controller, holder,
      `${executionId}:wu-contract-stage:${wuId}:${contract.contract_hash}`, "WU_CONTRACT_STAGE", body)
    return { action, commit_status: res.status, ...(await summary(controller)) }
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
    // A preactivation recovery pins one approved executable contract. Never
    // re-select an ambiguous DRAFT or silently replace the staged source.
    const staged = snap.state.staged_wu_contract
    if (staged && input.wu_artifact_id && input.wu_artifact_id !== staged.contract.source_record_key &&
      input.wu_artifact_id !== staged.source_artifact_id) {
      throw new Error("activate_wu source differs from the preactivation-staged approved contract")
    }
    // Validate lifecycle before loading a successor that is not yet eligible.
    applyEvent(snap.state, { operation_type: "WU_ACTIVATE",
      body: { wu_id: wuId, mandate_id: mandateId, ...(staged ? { contract: staged.contract } : {}) },
      next_revision: snap.state.revision + 1 })
    const contract = staged?.contract ?? compileWuContract(wuId,
      await readWorkUnitDefinition(projectRoot, wuId, snap.state.mandate.source_artifact_id, input.wu_artifact_id ?? wuId))
    const res = await commitAction(controller, holder, `${executionId}:activate:${wuId}`,
      "WU_ACTIVATE", { wu_id: wuId, mandate_id: mandateId, contract })
    return { action, commit_status: res.status, wu_id: wuId, ...(await summary(controller)) }
  }

  if (action === "status") {
    return { action, ...(await summary(controller)) }
  }

  if (action === "operational_status") {
    const { state, events } = await controller.snapshot()
    return { action, ...projectOperationalView(state, { events }) }
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
      const { state } = await controller.snapshot()
      if (body.expected_agent === 'harness-reviewer' && activeRecovery(state)) {
        const candidate = state.candidates[input.candidate_id]
        if (!candidate || candidate.wu_id !== state.wu.wu_id || candidate.superseded_by_contract) throw new Error('prepare_launch for process review requires the exact recorded candidate_id')
        body.process_review_candidate_id = input.candidate_id
      }
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
    const provenance = process.env.HARNESS_REVIEW_HANDOFF_STRICT === "1" && verdict === "PASS"
      ? assertTrustedReviewHandoff(snap.state, input) : null
    const res = await controller.commit(
      { operation_id: `${executionId}:review:${candidateId}:${stableHash({ verdict, evidenceIds, reviewer: input.reviewer ?? null, provenance })}`, operation_type: "RECORD_REVIEW", body: { candidate_id: candidateId, verdict, candidate_hashes: { manifest_hash: frozenCandidate.manifest_hash, tree_hash: frozenCandidate.tree_hash }, reviewer: input.reviewer ?? null, verification_evidence_ids: evidenceIds, verification_contract_hash: contractHash, verified_check_ids: verifiedCheckIds, ...(provenance ?? {}) } },
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

  if (action === "audit_recovery") return auditRecovery(controller)

  if (action === "block") {
    const cls = String(input.class ?? "")
    if (!cls) throw new Error("block requires class (a BLOCKER_CLASSES value).")
    const reason = String(input.reason ?? "")
    const { state } = await controller.snapshot()
    if (state.process_policy && cls === "BLOCKED_AUTHORITY") {
      const q = input.authority_question
      if (!q || !['product', 'scope', 'security', 'permission', 'budget', 'governance'].includes(q.domain) ||
          !q.decision?.trim() || !q.source_ref?.trim() || !q.why_not_delegated?.trim()) throw new Error("Identify the actual owner decision, source, domain and why it is not delegated; process deviations use start_process_recovery")
    }
    if (isStaleWorktreeScopeBlocker({ class: cls, reason })) {
      throw new Error("SCOPE_WORKTREE_CLASSIFICATION: a stale checkout is tooling/environment reconciliation, not proven business scope drift; use BLOCKED_TOOLING or inspect_scope_worktree")
    }
    if (cls === "BLOCKED_SCOPE") {
      const scope = input.scope_cause
      if (scope?.kind === "WORKTREE_MISMATCH") {
        throw new Error("SCOPE_WORKTREE_CLASSIFICATION: checkout drift is tooling, never terminal business scope")
      }
      if (!scope || scope.kind !== "FUNCTIONAL_SCOPE_CHANGE" ||
          typeof scope.authority_ref !== "string" || !scope.authority_ref.trim()) {
        throw new Error("SCOPE_CAUSE_REQUIRED: a new BLOCKED_SCOPE must identify the actual functional scope change and exact authority_ref")
      }
    }

    if (cls === "BLOCKED_PROCESS" && input.process_kind !== "TDD_ORDER") throw new Error("Typed process deviation required")
    if (!reason) throw new Error("block requires reason (a human-readable explanation of the stop).")
    const res = await commitObservation(controller, holder, `${executionId}:block`, "BLOCK", { class: cls, reason, ...(input.authority_question ? { authority_question: input.authority_question } : {}), ...(cls === "BLOCKED_SCOPE" ? { scope_cause: input.scope_cause } : {}), ...(cls === "BLOCKED_PROCESS" ? { kind: input.process_kind } : {}) }, () => true, state => Boolean(state.blocker))
    return { action, commit_status: res.status, ...(await summary(controller)) }
  }

  if (action === "inspect_scope_worktree") {
    const snap = await controller.snapshot()
    const classification = classifyScopeBlocker(snap.state.blocker)
    if (classification.kind === "SCOPE_CONFLICT" || classification.kind === "NOT_SCOPE") {
      return { action, status: "NOT_ELIGIBLE", revision: snap.state.revision,
        blocker: snap.state.blocker, classification, reason: classification.reason }
    }
    if (classification.kind === "EVIDENCE_REQUIRED") {
      return { action, status: "EVIDENCE_REQUIRED", revision: snap.state.revision,
        blocker: snap.state.blocker, classification, reason: classification.reason }
    }
    try {
      const roots = await verifyScopeCheckoutRoots(projectRoot, options.checkoutRoot ?? projectRoot)
      const proof = await inspectStaleWorktreeScope(roots.checkoutRoot, snap.state, registry)
      return { action, status: "VERIFIED_RECONCILABLE", revision: snap.state.revision,
        canonical_root: roots.canonicalRoot, classification, proof }
    } catch (error) {
      return { action, status: "NOT_VERIFIED", revision: snap.state.revision,
        classification, reason: error.message }
    }
  }

  if (action === "reconcile_stale_worktree_scope") {
    const expectedRevision = input.expected_revision
    const blockedAt = input.blocked_at_revision
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        !Number.isSafeInteger(blockedAt) || blockedAt < 0) {
      throw new Error("Scope reconciliation requires expected_revision and exact blocked_at_revision")
    }
    const lease = await controller.acquire(holder)
    const snap = await controller.snapshot()
    const operation_id = `${executionId}:scope-worktree:${blockedAt}`
    const prior = snap.events.find(e => e.operation_id === operation_id && e.operation_type === "SCOPE_WORKTREE_RECONCILE")
    if (prior && !snap.state.blocker && prior.body.expected_revision === expectedRevision) {
      const replay = await controller.commit({ operation_id, operation_type: "SCOPE_WORKTREE_RECONCILE", body: prior.body }, {
        holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token,
      })
      return { action, commit_status: replay.status, recovery_proof: prior.body.proof, ...(await summary(controller)) }
    }
    if (snap.state.revision !== expectedRevision) throw new Error("Scope reconciliation stale controller revision")
    if (snap.state.blocker?.at_revision !== blockedAt ||
        !isStaleWorktreeScopeBlocker(snap.state.blocker)) {
      throw new Error("Scope reconciliation cannot target a different or genuine scope blocker")
    }
    const roots = await verifyScopeCheckoutRoots(projectRoot, options.checkoutRoot ?? projectRoot)
    const proof = await inspectStaleWorktreeScope(roots.checkoutRoot, snap.state, registry)
    const body = { expected_revision: expectedRevision, blocked_at_revision: blockedAt,
      wu_id: snap.state.wu.wu_id, proof }
    const result = await controller.commit({ operation_id, operation_type: "SCOPE_WORKTREE_RECONCILE", body }, {
      holder_session_id: holder, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token,
    })
    return { action, commit_status: result.status, recovery_proof: proof, ...(await summary(controller)) }
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
      throw new Error(`clear_blocker cannot clear non-recoverable blocker ${blocker.class}.${blocker.class === "BUDGET_EXHAUSTED" ? " If the owner authorized planning estimates, use adopt_planning_estimates with decision_artifact_id; legacy finite allocations use amend_wu_budget. Neither increases the Epic total." : ""}`)
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
