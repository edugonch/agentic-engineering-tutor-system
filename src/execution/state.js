// State projection. state is derived, never canonical: events.ndjson is the
// source of truth and every read replays it. This makes divergence between a
// cached state file and the log impossible by construction.

import {
  BILLABLE_PHASES,
  BLOCKER_CLASSES,
  CI_CONCLUSIONS,
  DISPATCH_STATUS,
  EXECUTION_AUTHORIZATION,
  OPERATION_TYPES,
  RESERVATION_STATUS,
  TERMINAL_BLOCKER_CLASSES,
  WU_ORIGIN,
  MANDATE_AUTHORITY,
} from "./constants.js"

const FORWARD_EXECUTION_TYPES = new Set([
  "WU_ACTIVATE",
  "PHASE_START",
  "DISPATCH_RESERVE",
  "DISPATCH_PREPARE",
  "DISPATCH_LAUNCH",
])

const setsEqual = (a, b) => {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every((x) => sb.has(x))
}

export function initialState() {
  return {
    revision: 0,
    execution_id: null,
    mandate: null, // { mandate_id, mandate_revision, max_wus, total_seconds }
    wu: null, // { wu_id, mandate_id, mandate_revision, origin, execution_authorization, completed }
    activated_wu_ids: [], // history of every WU id ever activated (enforces max_wus + single-active-WU)
    budget: { total_seconds: 0, used_seconds: 0, reserved_seconds: 0, active_phase: null, active_started_at: null },
    dispatches: {}, // dispatch_id -> { status, session_id, operation_id, result, reconciled }
    candidates: {}, // candidate_id -> { manifest_hash, tree_hash, manifest }
    reviews: {}, // candidate_id -> { verdict, candidate_hashes, reviewer }
    pr_binding: null, // { repository, pr_number, candidate_id, head_sha, base_branch, base_sha, at_revision }
    ci_evidence: {}, // candidate_id -> check_identity -> { head_sha, conclusion, evidence_ref, observed_at }
    blocker: null, // { class, reason, at_revision }
    checkpoint: null, // { operation_id, revision, note, wu_id, used_seconds }
    completed: false,
    completion: null,
  }
}

export function project(events) {
  let state = initialState()
  for (const event of events) {
    if (event.previous_revision !== state.revision) {
      throw new Error(`State projection conflict at event ${event.sequence}: expected previous_revision ${state.revision}, got ${event.previous_revision}.`)
    }
    if (event.next_revision !== state.revision + 1) {
      throw new Error(`State projection conflict at event ${event.sequence}: non-sequential revision ${event.next_revision} after ${state.revision}.`)
    }
    state = applyEvent(state, event)
  }
  return state
}

export function applyEvent(previous, event) {
  if (!OPERATION_TYPES.includes(event.operation_type)) {
    throw new Error(`Unknown operation type: ${event.operation_type}.`)
  }
  const state = structuredClone(previous)
  const body = event.body ?? {}

  // A terminal blocker is a hard stop: no new WU, billable phase, or dispatch
  // may follow. Audit/record operations remain allowed so evidence and
  // reconciliation can still be committed.
  if (state.blocker && TERMINAL_BLOCKER_CLASSES.has(state.blocker.class) && FORWARD_EXECUTION_TYPES.has(event.operation_type)) {
    throw new Error(`Forward execution is blocked after ${state.blocker.class}; no alternative dispatch or phase is permitted.`)
  }

  switch (event.operation_type) {
    case "MANDATE_APPROVE": {
      if (!body.mandate_id) throw new Error("MANDATE_APPROVE requires mandate_id.")
      if (!Number.isSafeInteger(body.max_wus) || body.max_wus < 1) throw new Error("MANDATE_APPROVE requires a positive integer max_wus.")
      if (!Number.isFinite(body.total_seconds) || body.total_seconds <= 0) throw new Error("MANDATE_APPROVE requires a finite positive total_seconds budget.")
      state.execution_id = body.execution_id ?? state.execution_id
      state.mandate = {
        mandate_id: body.mandate_id,
        mandate_revision: body.mandate_revision ?? null,
        max_wus: body.max_wus,
        authority_kind: body.authority_kind ?? MANDATE_AUTHORITY.PROBE,
      }
      // Governed binding (approve_mandate) records the source of human authority;
      // legacy `init` has no source binding. The fields are present only when a
      // governed mandate supplied them, so the projection never fabricates one.
      if (body.source_artifact_id !== undefined || body.source_record_key !== undefined || body.source_hash !== undefined) {
        state.mandate.source_artifact_id = body.source_artifact_id ?? null
        state.mandate.source_record_key = body.source_record_key ?? null
        state.mandate.source_hash = body.source_hash ?? null
      }
      // A governed mandate must carry a complete, non-empty source binding so the
      // event log can never record an OWNER_APPROVED_EPIC mandate without authority.
      if (state.mandate.authority_kind === MANDATE_AUTHORITY.OWNER_APPROVED_EPIC) {
        if (!state.mandate.source_artifact_id || !state.mandate.source_record_key || !state.mandate.source_hash) {
          throw new Error("MANDATE_APPROVE: OWNER_APPROVED_EPIC requires source_artifact_id, source_record_key, and source_hash.")
        }
      }
      state.budget.total_seconds = body.total_seconds
      break
    }

    case "WU_ACTIVATE": {
      if (!state.mandate) throw new Error("WU_ACTIVATE requires an approved mandate.")
      if (!body.wu_id) throw new Error("WU_ACTIVATE requires wu_id.")
      if (body.mandate_id !== state.mandate.mandate_id) {
        throw new Error(`WU_ACTIVATE mandate mismatch: ${body.mandate_id} vs ${state.mandate.mandate_id}.`)
      }
      if (state.wu && !state.wu.completed) {
        throw new Error(`WU_ACTIVATE blocked: active WU ${state.wu.wu_id} is not complete.`)
      }
      if (state.activated_wu_ids.includes(body.wu_id)) {
        throw new Error(`WU_ACTIVATE blocked: WU ${body.wu_id} was already activated.`)
      }
      if (state.activated_wu_ids.length >= state.mandate.max_wus) {
        throw new Error(`WU_ACTIVATE blocked: mandate max_wus (${state.mandate.max_wus}) reached.`)
      }
      state.wu = {
        wu_id: body.wu_id,
        mandate_id: state.mandate.mandate_id,
        mandate_revision: state.mandate.mandate_revision,
        origin: WU_ORIGIN.DERIVED,
        execution_authorization: EXECUTION_AUTHORIZATION.AUTHORIZED_BY_MANDATE,
        completed: false,
      }
      state.activated_wu_ids.push(body.wu_id)
      break
    }

    case "PHASE_START": {
      if (state.budget.active_phase) throw new Error("Cannot start a phase while another is active.")
      if (!body.phase) throw new Error("PHASE_START requires a phase.")
      state.budget.active_phase = body.phase
      state.budget.active_started_at = body.started_at
      break
    }

    case "PHASE_END": {
      if (!state.budget.active_phase) throw new Error("Cannot end a phase when none is active.")
      const started = state.budget.active_started_at
      const ended = body.ended_at
      if (!Number.isFinite(ended)) throw new Error("PHASE_END requires a finite ended_at.")
      if (BILLABLE_PHASES.has(state.budget.active_phase)) {
        state.budget.used_seconds += Math.max(0, ended - started)
      }
      state.budget.active_phase = null
      state.budget.active_started_at = null
      break
    }

    case "DISPATCH_RESERVE": {
      if (!body.dispatch_id) throw new Error("DISPATCH_RESERVE requires dispatch_id.")
      if (state.dispatches[body.dispatch_id]) throw new Error(`Duplicate dispatch reservation: ${body.dispatch_id}.`)
      const reserved = body.reserved_seconds ?? 0
      if (!Number.isFinite(reserved) || reserved < 0) throw new Error("DISPATCH_RESERVE reserved_seconds must be a finite non-negative number.")
      state.dispatches[body.dispatch_id] = {
        status: DISPATCH_STATUS.RESERVED,
        session_id: null,
        operation_id: event.operation_id,
        wu_id: state.wu?.wu_id ?? null,
        reserved_seconds: reserved,
        reservation_status: RESERVATION_STATUS.RESERVED,
        actual_consumption: null,
        result: null,
        reconciled: null,
      }
      state.budget.reserved_seconds += reserved
      break
    }

    case "DISPATCH_PREPARE": {
      const d = state.dispatches[body.dispatch_id]
      if (!d || d.status !== DISPATCH_STATUS.RESERVED) throw new Error(`Cannot prepare dispatch ${body.dispatch_id}: not reserved.`)
      d.status = DISPATCH_STATUS.PENDING_LAUNCH
      // Launch-intent binding (Wave B): when the orchestrator prepares a launch it
      // may record what it intends to launch so the runtime can claim the exact
      // dispatch before the external side effect. Optional for backward
      // compatibility with V1 event logs that prepared without these fields.
      if (body.prepared_by_session_id !== undefined) d.prepared_by_session_id = body.prepared_by_session_id
      if (body.expected_agent !== undefined) d.expected_agent = body.expected_agent
      if (body.claim_required !== undefined) d.claim_required = body.claim_required === true
      break
    }

    case "DISPATCH_LAUNCH_CLAIM": {
      const d = state.dispatches[body.dispatch_id]
      if (!d) throw new Error(`Cannot claim unknown dispatch ${body.dispatch_id}.`)
      if (d.status !== DISPATCH_STATUS.PENDING_LAUNCH) throw new Error(`Cannot claim dispatch ${body.dispatch_id}: not pending launch (status ${d.status}).`)
      // The launch-claim boundary is opt-in: only dispatches prepared under the
      // Wave B contract may be claimed. A legacy V1 dispatch (no claim_required)
      // can never be turned into a claimed dispatch accidentally.
      if (d.claim_required !== true) throw new Error(`Cannot claim dispatch ${body.dispatch_id}: not prepared with claim_required.`)
      if (d.launch_call_id) throw new Error(`Cannot claim dispatch ${body.dispatch_id}: launch already claimed with call ${d.launch_call_id}.`)
      if (!body.call_id) throw new Error("DISPATCH_LAUNCH_CLAIM requires call_id.")
      d.launch_call_id = body.call_id
      d.launch_claimed_at = event.timestamp
      break
    }

    case "DISPATCH_LAUNCH": {
      const d = state.dispatches[body.dispatch_id]
      if (!d || (d.status !== DISPATCH_STATUS.RESERVED && d.status !== DISPATCH_STATUS.PENDING_LAUNCH)) {
        throw new Error(`Cannot launch dispatch ${body.dispatch_id}: not reserved/pending.`)
      }
      if (!body.session_id) throw new Error("DISPATCH_LAUNCH requires session_id.")
      // New-contract dispatches (prepared under Wave B with claim_required) must
      // cross the launch boundary through a durable DISPATCH_LAUNCH_CLAIM first.
      // Historical V1 dispatches have no claim_required and launch unchanged.
      if (d.claim_required === true && !d.launch_call_id) {
        throw new Error(`Cannot launch dispatch ${body.dispatch_id}: claim_required dispatch has no launch claim (DISPATCH_LAUNCH_CLAIM first).`)
      }
      d.status = DISPATCH_STATUS.LAUNCHED
      d.session_id = body.session_id
      break
    }

    case "DISPATCH_FINISH": {
      const d = state.dispatches[body.dispatch_id]
      if (!d || d.status !== DISPATCH_STATUS.LAUNCHED) throw new Error(`Cannot finish dispatch ${body.dispatch_id}: not launched.`)
      d.status = DISPATCH_STATUS.FINISHED
      d.result = body.result ?? null
      break
    }

    case "DISPATCH_RECONCILE": {
      const d = state.dispatches[body.dispatch_id]
      if (!d) throw new Error(`Cannot reconcile unknown dispatch ${body.dispatch_id}.`)
      if (d.status !== DISPATCH_STATUS.FINISHED) throw new Error(`Cannot reconcile dispatch ${body.dispatch_id}: not finished (status ${d.status}).`)
      if (d.reservation_status !== RESERVATION_STATUS.RESERVED) throw new Error(`Cannot reconcile dispatch ${body.dispatch_id}: reservation already ${d.reservation_status}.`)
      const reserved = d.reserved_seconds
      const reported = body.actual_consumption
      // Conservative policy: unknown consumption is never rewritten to zero; a
      // missing report consumes the whole reservation.
      const actual = reported === undefined || reported === null ? reserved : reported
      if (!Number.isFinite(actual) || actual < 0) throw new Error("DISPATCH_RECONCILE actual_consumption must be a finite non-negative number.")
      if (actual > reserved) throw new Error(`DISPATCH_RECONCILE consumption ${actual} exceeds reservation ${reserved}; overrun requires an explicit transition, never a silent adjustment.`)
      d.status = DISPATCH_STATUS.RESULT_RECONCILED
      d.reservation_status = RESERVATION_STATUS.CONSUMED
      d.actual_consumption = actual
      d.reconciled = { verdict: body.verdict ?? null, evidence: body.evidence ?? null, at_revision: state.revision }
      state.budget.reserved_seconds -= reserved
      state.budget.used_seconds += actual
      break
    }

    case "DISPATCH_RELEASE": {
      const d = state.dispatches[body.dispatch_id]
      if (!d) throw new Error(`Cannot release unknown dispatch ${body.dispatch_id}.`)
      if (d.status !== DISPATCH_STATUS.RESERVED && d.status !== DISPATCH_STATUS.PENDING_LAUNCH) {
        throw new Error(`Cannot release dispatch ${body.dispatch_id}: not in a never-launched state (status ${d.status}).`)
      }
      // A claimed launch means the side effect may have occurred even without a
      // recorded session identity; releasing would treat an uncertain outcome as
      // deterministically never-launched. mark_ambiguous is the correct path.
      if (d.launch_call_id) {
        throw new Error(`Cannot release dispatch ${body.dispatch_id}: launch was claimed (launch_call_id set); mark it ambiguous instead of releasing.`)
      }
      if (d.reservation_status !== RESERVATION_STATUS.RESERVED) throw new Error(`Cannot release dispatch ${body.dispatch_id}: reservation already ${d.reservation_status}.`)
      const reserved = d.reserved_seconds
      d.status = DISPATCH_STATUS.RELEASED
      d.reservation_status = RESERVATION_STATUS.RELEASED
      state.budget.reserved_seconds -= reserved
      break
    }

    case "DISPATCH_MARK_AMBIGUOUS": {
      const d = state.dispatches[body.dispatch_id]
      if (!d) throw new Error(`Cannot mark unknown dispatch ${body.dispatch_id} ambiguous.`)
      if (d.status !== DISPATCH_STATUS.RESERVED && d.status !== DISPATCH_STATUS.PENDING_LAUNCH) {
        throw new Error(`Cannot mark dispatch ${body.dispatch_id} ambiguous from status ${d.status}.`)
      }
      d.status = DISPATCH_STATUS.AMBIGUOUS
      // The reservation stays held: unknown must never become zero, and there
      // is no auto-release or auto-retry from AMBIGUOUS.
      break
    }

    case "FREEZE_CANDIDATE": {
      if (!body.candidate_id) throw new Error("FREEZE_CANDIDATE requires candidate_id.")
      if (!body.manifest_hash || !body.tree_hash) throw new Error("FREEZE_CANDIDATE requires manifest_hash and tree_hash.")
      if (state.candidates[body.candidate_id]) throw new Error(`Duplicate candidate: ${body.candidate_id}.`)
      if (body.wu_id && state.wu && body.wu_id !== state.wu.wu_id) {
        throw new Error(`FREEZE_CANDIDATE wu mismatch: candidate belongs to ${body.wu_id}, active WU is ${state.wu.wu_id}.`)
      }
      state.candidates[body.candidate_id] = {
        wu_id: body.wu_id ?? null,
        manifest_hash: body.manifest_hash,
        tree_hash: body.tree_hash,
        manifest: body.manifest ?? null,
        verification_contract_hash: body.verification_contract_hash ?? null,
        required_check_ids: body.required_check_ids ?? [],
      }
      break
    }

    case "RECORD_REVIEW": {
      const candidate = state.candidates[body.candidate_id]
      if (!candidate) throw new Error(`Cannot review unknown candidate ${body.candidate_id}.`)
      const hashes = body.candidate_hashes ?? {}
      if (hashes.manifest_hash !== candidate.manifest_hash || hashes.tree_hash !== candidate.tree_hash) {
        throw new Error(`Review hash mismatch for candidate ${body.candidate_id}: a review cannot accredit a different candidate.`)
      }
      const evidenceIds = body.verification_evidence_ids ?? []
      const verifiedCheckIds = body.verified_check_ids ?? []
      if (body.verdict === "PASS") {
        if (evidenceIds.length === 0) throw new Error("RECORD_REVIEW: a PASS verdict requires verification evidence.")
        if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error("RECORD_REVIEW: duplicate evidence ids in a PASS verdict.")
        if (new Set(verifiedCheckIds).size !== verifiedCheckIds.length) throw new Error("RECORD_REVIEW: duplicate check coverage in a PASS verdict.")
        if (!setsEqual(verifiedCheckIds, candidate.required_check_ids ?? [])) {
          throw new Error(`RECORD_REVIEW: PASS requires full verification coverage (verified ${verifiedCheckIds.join(",") || "none"}, required ${(candidate.required_check_ids ?? []).join(",") || "none"}).`)
        }
        if ((body.verification_contract_hash ?? null) !== (candidate.verification_contract_hash ?? null)) {
          throw new Error("RECORD_REVIEW: verification contract hash mismatch.")
        }
      }
      state.reviews[body.candidate_id] = {
        verdict: body.verdict ?? null,
        candidate_hashes: { manifest_hash: candidate.manifest_hash, tree_hash: candidate.tree_hash },
        reviewer: body.reviewer ?? null,
        verification_evidence_ids: evidenceIds,
        verification_contract_hash: body.verification_contract_hash ?? null,
        verified_check_ids: verifiedCheckIds,
      }
      break
    }

    case "CHECKPOINT": {
      state.checkpoint = {
        operation_id: event.operation_id,
        revision: state.revision,
        note: body.note ?? null,
        wu_id: state.wu?.wu_id ?? null,
        used_seconds: state.budget.used_seconds,
      }
      break
    }

    case "BLOCK": {
      if (!BLOCKER_CLASSES.includes(body.class)) throw new Error(`Unknown blocker class: ${body.class}.`)
      state.blocker = { class: body.class, reason: body.reason ?? null, at_revision: state.revision }
      break
    }

    case "BIND_PR": {
      const candidate = state.candidates[body.candidate_id]
      if (!candidate) throw new Error(`BIND_PR: unknown candidate ${body.candidate_id}.`)
      if (state.wu && candidate.wu_id !== state.wu.wu_id) {
        throw new Error(`BIND_PR: candidate ${body.candidate_id} belongs to ${candidate.wu_id}, not the active WU ${state.wu.wu_id}.`)
      }
      if (!body.repository) throw new Error("BIND_PR requires repository.")
      if (!Number.isSafeInteger(body.pr_number) || body.pr_number < 1) throw new Error("BIND_PR requires a positive integer pr_number.")
      if (!body.head_sha) throw new Error("BIND_PR requires head_sha.")
      if (!body.base_branch) throw new Error("BIND_PR requires base_branch.")
      if (!body.base_sha) throw new Error("BIND_PR requires base_sha.")
      const binding = {
        repository: body.repository,
        pr_number: body.pr_number,
        candidate_id: body.candidate_id,
        head_sha: body.head_sha,
        base_branch: body.base_branch,
        base_sha: body.base_sha,
        at_revision: state.revision,
      }
      // Immutable binding: a different PR/head/base must not silently overwrite
      // the existing one (a head change requires a new candidate + fresh review).
      // The exact same binding may be re-applied (idempotent).
      if (state.pr_binding) {
        const existing = state.pr_binding
        const same =
          existing.repository === binding.repository &&
          existing.pr_number === binding.pr_number &&
          existing.candidate_id === binding.candidate_id &&
          existing.head_sha === binding.head_sha &&
          existing.base_branch === binding.base_branch &&
          existing.base_sha === binding.base_sha
        if (!same) {
          throw new Error(`BIND_PR: already bound to repository ${existing.repository} PR #${existing.pr_number} head ${existing.head_sha}; rebinding a different PR/head requires a new candidate and review.`)
        }
      }
      state.pr_binding = binding
      break
    }

    case "RECORD_CI": {
      const candidate = state.candidates[body.candidate_id]
      if (!candidate) throw new Error(`RECORD_CI: unknown candidate ${body.candidate_id}.`)
      if (!body.head_sha) throw new Error("RECORD_CI requires head_sha.")
      if (!body.check_identity) throw new Error("RECORD_CI requires check_identity.")
      if (!CI_CONCLUSIONS.includes(body.conclusion)) throw new Error(`RECORD_CI invalid conclusion: ${body.conclusion}.`)
      // Multiple checks per candidate: keyed by check_identity so a later check
      // never overwrites an earlier one.
      if (!state.ci_evidence[body.candidate_id]) state.ci_evidence[body.candidate_id] = {}
      state.ci_evidence[body.candidate_id][body.check_identity] = {
        head_sha: body.head_sha,
        conclusion: body.conclusion,
        evidence_ref: body.evidence_ref ?? null,
        observed_at: event.timestamp,
      }
      break
    }

    case "WU_COMPLETE": {
      if (!state.wu) throw new Error("WU_COMPLETE requires an active WU.")
      if (state.wu.completed) throw new Error("WU_COMPLETE: the active WU is already complete.")
      const candidateId = body.candidate_id
      if (!candidateId) throw new Error("WU_COMPLETE requires candidate_id.")
      const candidate = state.candidates[candidateId]
      if (!candidate) throw new Error(`WU_COMPLETE: unknown candidate ${candidateId}.`)
      if (candidate.wu_id !== state.wu.wu_id) {
        throw new Error(`WU_COMPLETE: candidate ${candidateId} belongs to ${candidate.wu_id}, not the active WU ${state.wu.wu_id}.`)
      }
      const review = state.reviews[candidateId]
      if (!review) throw new Error(`WU_COMPLETE: no review recorded for candidate ${candidateId}.`)
      if (review.verdict !== "PASS") {
        throw new Error(`WU_COMPLETE: review verdict is ${review.verdict}, not PASS.`)
      }
      const settled = new Set([DISPATCH_STATUS.RESULT_RECONCILED, DISPATCH_STATUS.RELEASED])
      const unsettled = Object.entries(state.dispatches).filter(([, d]) => !settled.has(d.status))
      if (unsettled.length > 0) {
        throw new Error(`WU_COMPLETE: ${unsettled.length} dispatch(es) not settled (must be RESULT_RECONCILED or RELEASED): ${unsettled.map(([id]) => id).join(", ")}.`)
      }
      state.wu.completed = true
      state.wu.completion = { candidate_id: candidateId, at_revision: state.revision }
      break
    }

    case "COMPLETE": {
      if (state.wu && !state.wu.completed) {
        throw new Error(`COMPLETE blocked: active WU ${state.wu.wu_id} is not complete.`)
      }
      state.completed = true
      state.completion = { result: body.result ?? null, at_revision: state.revision }
      break
    }

    default:
      throw new Error(`Unhandled operation type: ${event.operation_type}.`)
  }

  assertBudgetInvariants(state.budget)

  state.revision = event.next_revision
  return state
}

// Structural budget invariants enforced on every projection step. These are the
// fail-closed guards that make "reservation/liquidation is balanced" a property
// of the projection, not of the caller. They never depend on the wall-clock
// total (total_seconds is a soft ceiling, checked at readiness, not here).
function assertBudgetInvariants(budget) {
  if (budget.reserved_seconds < 0) throw new Error("Invariant violation: reserved_seconds must never be negative.")
  if (budget.used_seconds < 0) throw new Error("Invariant violation: used_seconds must never be negative.")
}

// Derived budget view for authorization. The projection reproduces the ledger
// faithfully (it may describe over-budget history); this function computes the
// authorization view WITHOUT invalidating anything. available_seconds may be
// negative (overrun) — that is a reconstructible fact, not a projection error.
export function deriveBudget(budget) {
  const available_seconds = budget.total_seconds - budget.used_seconds - budget.reserved_seconds
  return {
    total_seconds: budget.total_seconds,
    used_seconds: budget.used_seconds,
    reserved_seconds: budget.reserved_seconds,
    available_seconds,
    exhausted: available_seconds <= 0,
    overrun: available_seconds < 0,
  }
}
