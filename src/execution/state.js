// State projection. state is derived, never canonical: events.ndjson is the
// source of truth and every read replays it. This makes divergence between a
// cached state file and the log impossible by construction.

import {
  BILLABLE_PHASES,
  BLOCKER_CLASSES,
  DISPATCH_STATUS,
  EXECUTION_AUTHORIZATION,
  OPERATION_TYPES,
  TERMINAL_BLOCKER_CLASSES,
} from "./constants.js"

const FORWARD_EXECUTION_TYPES = new Set([
  "WU_ACTIVATE",
  "PHASE_START",
  "DISPATCH_RESERVE",
  "DISPATCH_PREPARE",
  "DISPATCH_LAUNCH",
])

export function initialState() {
  return {
    revision: 0,
    execution_id: null,
    mandate: null, // { mandate_id, mandate_revision, max_wus, total_seconds }
    wu: null, // { wu_id, mandate_id, mandate_revision, authorization }
    budget: { total_seconds: 0, used_seconds: 0, active_phase: null, active_started_at: null },
    dispatches: {}, // dispatch_id -> { status, session_id, operation_id, result, reconciled }
    candidates: {}, // candidate_id -> { manifest_hash, tree_hash, manifest }
    reviews: {}, // candidate_id -> { verdict, candidate_hashes, reviewer }
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
      state.wu = {
        wu_id: body.wu_id,
        mandate_id: state.mandate.mandate_id,
        mandate_revision: state.mandate.mandate_revision,
        authorization: EXECUTION_AUTHORIZATION.AUTHORIZED_BY_MANDATE,
      }
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
      state.dispatches[body.dispatch_id] = {
        status: DISPATCH_STATUS.RESERVED,
        session_id: null,
        operation_id: event.operation_id,
        result: null,
        reconciled: null,
      }
      break
    }

    case "DISPATCH_PREPARE": {
      const d = state.dispatches[body.dispatch_id]
      if (!d || d.status !== DISPATCH_STATUS.RESERVED) throw new Error(`Cannot prepare dispatch ${body.dispatch_id}: not reserved.`)
      d.status = DISPATCH_STATUS.PENDING_LAUNCH
      break
    }

    case "DISPATCH_LAUNCH": {
      const d = state.dispatches[body.dispatch_id]
      if (!d || (d.status !== DISPATCH_STATUS.RESERVED && d.status !== DISPATCH_STATUS.PENDING_LAUNCH)) {
        throw new Error(`Cannot launch dispatch ${body.dispatch_id}: not reserved/pending.`)
      }
      if (!body.session_id) throw new Error("DISPATCH_LAUNCH requires session_id.")
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
      d.reconciled = { verdict: body.verdict ?? null, evidence: body.evidence ?? null, at_revision: state.revision }
      break
    }

    case "FREEZE_CANDIDATE": {
      if (!body.candidate_id) throw new Error("FREEZE_CANDIDATE requires candidate_id.")
      if (!body.manifest_hash || !body.tree_hash) throw new Error("FREEZE_CANDIDATE requires manifest_hash and tree_hash.")
      if (state.candidates[body.candidate_id]) throw new Error(`Duplicate candidate: ${body.candidate_id}.`)
      state.candidates[body.candidate_id] = {
        manifest_hash: body.manifest_hash,
        tree_hash: body.tree_hash,
        manifest: body.manifest ?? null,
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
      state.reviews[body.candidate_id] = {
        verdict: body.verdict ?? null,
        candidate_hashes: { manifest_hash: candidate.manifest_hash, tree_hash: candidate.tree_hash },
        reviewer: body.reviewer ?? null,
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

    case "COMPLETE": {
      state.completed = true
      state.completion = { result: body.result ?? null, at_revision: state.revision }
      break
    }

    default:
      throw new Error(`Unhandled operation type: ${event.operation_type}.`)
  }

  state.revision = event.next_revision
  return state
}
