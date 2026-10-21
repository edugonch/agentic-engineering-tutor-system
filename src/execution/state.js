import { expiredWait, terminalObservation } from "./external-observation.js"
import { applyProcessEvent, activeRecovery, assertProcessAcceptance, requiresTdd, processPending } from "./process-recovery.js"
import { stableHash, sha256 } from "./serialize.js"
import { PLANNING_ESTIMATES } from "./time-policy.js"
import { isTechnicalWuContractBlocker } from "./jit-contract.js"
import { validateContractCorrection } from "./contract-correction.js"
import { executionProgress, supervisorProgress } from "./progress.js"
import { isStaleWorktreeScopeBlocker } from "./scope-recovery.js"
import { wuBudgetUsage } from "./wu-budget.js"
// State projection. state is derived, never canonical: events.ndjson is the
// source of truth and every read replays it. This makes divergence between a
// cached state file and the log impossible by construction.

import {
  BILLABLE_PHASES,
  BLOCKER_CLASSES,
  CI_CONCLUSIONS,
  DISPATCH_STATUS,
  EXECUTION_AUTHORIZATION,
  MERGE_POLICIES,
  OPERATION_TYPES,
  RESERVATION_STATUS,
  TERMINAL_BLOCKER_CLASSES,
  RECOVERABLE_BLOCKER_CLASSES,
  WU_ORIGIN,
  MANDATE_AUTHORITY,
} from "./constants.js"

const FORWARD_EXECUTION_TYPES = new Set([
  "WU_ACTIVATE",
  "PHASE_START",
  "DISPATCH_RESERVE",
  "DISPATCH_PREPARE",
  "DISPATCH_LAUNCH",
  "DISPATCH_LAUNCH_CLAIM", // claiming a launch is forward execution (a hard stop forbids it)
  "MERGE_START", // starting a governed merge is forward execution
  "MERGE_EXTERNAL_RECORD", // recording an external merge is forward integration
])

const setsEqual = (a, b) => {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every((x) => sb.has(x))
}

// Structural governed-merge gate. The merge policy can never come from a tool
// input; this evaluates durable state against the immutable PR binding, the PASS
// review, exact-head CI evidence, and settled dispatches. Pure and exported so it
// can be tested in isolation.
export function canStartMerge(state, { historicalReplay = false } = {}) {
  try { assertProcessAcceptance(state, state.pr_binding?.candidate_id) } catch (e) { return { allowed: false, reason: e.message } }
  if (state.verification_phase) return { allowed: false, reason: "verification is still running" }
  if (!state.wu) return { allowed: false, reason: "no active WU" }
  if (state.wu.completed) return { allowed: false, reason: "active WU already complete" }
  const binding = state.pr_binding
  if (!binding) return { allowed: false, reason: "no PR binding" }
  const candidate = state.candidates[binding.candidate_id]
  if (!candidate) return { allowed: false, reason: "bound candidate not recorded" }
  if (candidate.wu_id !== state.wu.wu_id) return { allowed: false, reason: "bound candidate not in active WU" }
  if (candidate.superseded_by_contract) return { allowed: false, reason: "candidate contract superseded; refreeze and review" }
  const review = state.reviews[binding.candidate_id]
  if (!review || review.verdict !== "PASS") return { allowed: false, reason: "no PASS review" }
  if (!historicalReplay && (!Array.isArray(review.verification_evidence_ids) || review.verification_evidence_ids.length === 0)) {
    return { allowed: false, reason: "PASS review lacks verification evidence; reverify and review the candidate" }
  }
  if (state.mandate?.merge_policy !== "governed_auto") return { allowed: false, reason: `merge policy is ${state.mandate?.merge_policy ?? "none"}, not governed_auto` }
  if (state.blocker) return { allowed: false, reason: `unresolved blocker ${state.blocker.class}` }
  const settled = new Set([DISPATCH_STATUS.RESULT_RECONCILED, DISPATCH_STATUS.ABANDONED_RECONCILED, DISPATCH_STATUS.RELEASED])
  const unsettled = Object.values(state.dispatches).filter((d) => !settled.has(d.status))
  if (unsettled.length > 0) return { allowed: false, reason: `${unsettled.length} unsettled dispatch(es)` }
  const required = state.mandate?.required_ci_checks ?? []
  // [] disables CI by approved mandate, never implying that CI passed.
  // The review, process, dispatch and exact-binding gates above still apply.
  const evidence = state.ci_evidence[binding.candidate_id]
  for (const check of required) {
    const e = evidence?.[check]
    if (!e) return { allowed: false, reason: `required CI ${check} is missing` }
    if (e.conclusion !== "SUCCESS") return { allowed: false, reason: `required CI ${check} conclusion is ${e.conclusion}, not SUCCESS` }
    if (e.head_sha !== binding.head_sha) return { allowed: false, reason: `required CI ${check} head ${e.head_sha} does not match bound head ${binding.head_sha}` }
  }
  return { allowed: true }
}

// Structural gate for the human merge policy: the Harness observes/verifies an
// already-performed external merge — it never authorizes executing one. CI is
// not required here (the side effect already happened); it is checked remotely
// in the orchestration when the mandate declares required_ci_checks.
export function canVerifyExternalMerge(state) {
  try { assertProcessAcceptance(state, state.pr_binding?.candidate_id) } catch (e) { return { allowed: false, reason: e.message } }
  if (!state.wu) return { allowed: false, reason: "no active WU" }
  if (state.wu.completed) return { allowed: false, reason: "active WU already complete" }
  const binding = state.pr_binding
  if (!binding) return { allowed: false, reason: "no PR binding" }
  const candidate = state.candidates[binding.candidate_id]
  if (!candidate) return { allowed: false, reason: "bound candidate not recorded" }
  if (candidate.wu_id !== state.wu.wu_id) return { allowed: false, reason: "bound candidate not in active WU" }
  if (candidate.superseded_by_contract) return { allowed: false, reason: "candidate contract superseded; refreeze and review" }
  const review = state.reviews[binding.candidate_id]
  if (!review || review.verdict !== "PASS") return { allowed: false, reason: "no PASS review" }
  if (!Array.isArray(review.verification_evidence_ids) || review.verification_evidence_ids.length === 0) {
    return { allowed: false, reason: "PASS review lacks verification evidence; reverify and review the candidate" }
  }
  if (state.mandate?.merge_policy !== "human") return { allowed: false, reason: `merge policy is ${state.mandate?.merge_policy ?? "none"}, not human` }
  if (state.blocker) return { allowed: false, reason: `unresolved blocker ${state.blocker.class}` }
  const settled = new Set([DISPATCH_STATUS.RESULT_RECONCILED, DISPATCH_STATUS.ABANDONED_RECONCILED, DISPATCH_STATUS.RELEASED])
  const unsettled = Object.values(state.dispatches).filter((d) => !settled.has(d.status))
  if (unsettled.length > 0) return { allowed: false, reason: `${unsettled.length} unsettled dispatch(es)` }
  return { allowed: true }
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
    pr_bindings: {}, // immutable bindings indexed by candidate; rebuilt from legacy events
    merges: {}, // merge history indexed by candidate
    completed_wus: {}, // WU completion receipts
    pr_binding: null, // { repository, pr_number, candidate_id, head_sha, base_branch, base_sha, at_revision }
    ci_evidence: {}, // candidate_id -> check_identity -> { head_sha, conclusion, evidence_ref, observed_at }
    merge: null, // { status, candidate_id, repository, pr_number, expected_head_sha, expected_base_sha, started_at_revision, merge_commit_sha, merged_head_sha, verified_at_revision }
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
    // Historical logs must remain replayable under the validation semantics at
    // the time of their recording. Fresh commits still use strict admission.
    state = applyEvent(state, event, { historicalReplay: true })
  }
  return state
}

export function applyEvent(previous, event, { historicalReplay = false } = {}) {
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
    case "PROCESS_POLICY_ADOPT":
    case "PROCESS_RECOVERY_START":
    case "PROCESS_EVIDENCE":
    case "PROCESS_RED_RECORD":
    case "PROCESS_REVIEW":
      applyProcessEvent(state, event)
      break

    case "EXTERNAL_OBSERVATION_RECOVER": {
      const wait = expiredWait(state, body.operation)
      if (!wait || wait.wait_id !== body.wait_id || state.blocker.at_revision !== body.blocked_at_revision || !terminalObservation(state, body.operation, body.observation)) throw new Error("Exact expired wait and terminal remote observation required")
      state.last_blocker_resolution = { ...state.blocker, resolution: "Remote condition observed; ordinary merge gates still apply", observation: body.observation, at_revision: state.revision }
      state.blocker = null
      break
    }
    case "EXTERNAL_WAIT": {
      const old = state.external_wait
      if (state.completed || state.blocker || !state.wu || state.wu.completed) throw new Error("Execution cannot enter external wait")
      if (!body.wait_id || !body.operation || !["CI_PENDING", "REMOTE_TRANSIENT"].includes(body.kind)) throw new Error("Invalid external wait identity/kind")
      if (old && (old.wait_id !== body.wait_id || old.operation !== body.operation || old.started_at !== body.started_at || old.deadline_at !== body.deadline_at)) throw new Error("External wait identity changed")
      if (body.attempt !== (old?.attempt ?? 0) + 1) throw new Error("External wait attempt out of order")
      const dates = [body.started_at, body.next_retry_at, body.deadline_at].map(Date.parse)
      if (dates.some(d => !Number.isFinite(d)) || dates[0] > dates[1] || dates[1] > dates[2]) throw new Error("Invalid external wait interval")
      state.external_wait = { ...body, due: false }
      break
    }
    case "EXTERNAL_WAIT_DUE": {
      const w = state.external_wait
      if (!w || w.wait_id !== body.wait_id || w.attempt !== body.attempt || state.blocker || state.completed) throw new Error("External wait no longer eligible")
      if (Date.parse(event.timestamp) < Date.parse(w.next_retry_at)) throw new Error("External wait is not due")
      w.due = true
      break
    }
    case "EXTERNAL_WAIT_END": {
      if (state.external_wait?.wait_id !== body.wait_id || !["RESOLVED", "REJECTED", "EXPIRED"].includes(body.outcome)) throw new Error("External wait end mismatch")
      state.external_wait_history ??= []
      state.external_wait_history.push({ ...state.external_wait, outcome: body.outcome, ended_at: event.timestamp, ...(body.recovery_version === 1 ? { ended_at_revision: state.revision } : {}), ...(body.observation ? { observation: body.observation } : {}) })
      if (body.outcome === "EXPIRED" && !state.blocker) state.blocker = { class: "BLOCKED_EXTERNAL_FACT", at_revision: state.revision,
        reason: `${state.external_wait.operation}: ${state.external_wait.kind} did not recover before ${state.external_wait.deadline_at}. Last observation: ${state.external_wait.reason}` }
      state.external_wait = null
      break
    }
    case "SUPERVISOR_BIND": {
      if (!body.session_id || state.mandate?.authority_kind !== MANDATE_AUTHORITY.OWNER_APPROVED_EPIC) throw new Error("Supervisor requires an approved execution and root identity")
      state.supervisor = { session_id: body.session_id, intent: null }
      break
    }
    case "SUPERVISOR_CONTINUE": {
      // Only an exact recoverable tooling blocker permits one read-only diagnostic
      // continuation; authority/scope/security blockers remain hard stops.
      const toolingTriage = state.blocker?.class === "BLOCKED_TOOLING" && !expiredWait(state)
      const contractTriage = isTechnicalWuContractBlocker(state.blocker) && (!state.wu || state.wu.completed)
      const scopeTriage = isStaleWorktreeScopeBlocker(state.blocker)
      if (!state.supervisor || (state.blocker && !expiredWait(state) && !toolingTriage && !contractTriage && !scopeTriage) ||
          state.completed || supervisorProgress(state) !== body.progress_hash) throw new Error("Continuation no longer eligible")
      const previous = state.supervisor.intent
      const attempt = body.attempt ?? 1
      if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 2) throw new Error("Supervisor continuation attempt is invalid")
      if (previous?.sent && previous.progress_hash === body.progress_hash) {
        // Only a *received and terminal-observed* turn with no durable progress
        // can authorize one bounded retry. Merely sending/queuing a prompt cannot.
        if (!previous.received || !previous.turn_observed || attempt !== (previous.attempt ?? 1) + 1) {
          throw new Error("Supervisor retry requires observed no-progress root turn")
        }
      } else if (attempt !== 1) throw new Error("New supervisor progress must start at attempt 1")
      state.supervisor.intent = { ...body, attempt, sent: false, received: false, turn_observed: false }
      break
    }
    case "SUPERVISOR_SENT": {
      if (state.supervisor?.intent?.intent_id !== body.intent_id) throw new Error("Continuation intent mismatch")
      state.supervisor.intent.sent = true
      break
    }
    case "SUPERVISOR_RECEIVED": {
      const intent = state.supervisor?.intent
      if (!intent || intent.intent_id !== body.intent_id || state.supervisor.session_id !== body.session_id ||
          intent.progress_hash !== body.progress_hash) throw new Error("Supervisor receipt identity mismatch")
      if (intent.received) throw new Error("Supervisor continuation already received")
      intent.received = true
      intent.received_at_revision = state.revision
      break
    }
    case "SUPERVISOR_TURN_OBSERVED": {
      const intent = state.supervisor?.intent
      if (!intent || intent.intent_id !== body.intent_id || !intent.sent || !intent.received || intent.turn_observed ||
          intent.progress_hash !== body.progress_hash || supervisorProgress(state) !== intent.progress_hash) {
        throw new Error("Supervisor turn observation requires delivered same-progress root completion")
      }
      intent.turn_observed = true
      intent.observed_at_revision = state.revision
      break
    }

    case "MANDATE_APPROVE": {
      if (!body.mandate_id) throw new Error("MANDATE_APPROVE requires mandate_id.")
      if (!Number.isSafeInteger(body.max_wus) || body.max_wus < 1) throw new Error("MANDATE_APPROVE requires a positive integer max_wus.")
      if (!Number.isFinite(body.total_seconds) || body.total_seconds <= 0) throw new Error("MANDATE_APPROVE requires a finite positive total_seconds budget.")
      if (body.time_policy !== undefined) {
        if (body.time_policy !== PLANNING_ESTIMATES) throw new Error("Unknown time policy")
        state.time_policy = { mode: body.time_policy, source: "initial_mandate", at_revision: state.revision }
      }
      state.execution_id = body.execution_id ?? state.execution_id
      state.mandate = {
        mandate_id: body.mandate_id,
        mandate_revision: body.mandate_revision ?? null,
        max_wus: body.max_wus,
        authority_kind: body.authority_kind ?? MANDATE_AUTHORITY.PROBE,
        merge_policy: body.merge_policy ?? "none",
        required_ci_checks: body.required_ci_checks ?? [],
      }
      if (!MERGE_POLICIES.includes(state.mandate.merge_policy)) {
        throw new Error(`MANDATE_APPROVE: unknown merge_policy ${state.mandate.merge_policy}.`)
      }
      if (body.wu_sequence !== undefined) {
        if (!Array.isArray(body.wu_sequence) || body.wu_sequence.length === 0) {
          throw new Error("MANDATE_APPROVE: wu_sequence must be a non-empty array when provided.")
        }
        if (body.wu_sequence.length > body.max_wus) {
          throw new Error("MANDATE_APPROVE: wu_sequence exceeds max_wus.")
        }
        if (new Set(body.wu_sequence).size !== body.wu_sequence.length) {
          throw new Error("MANDATE_APPROVE: wu_sequence cannot contain duplicates.")
        }
        if (body.wu_sequence.some((wu) => typeof wu !== "string" || wu.length === 0)) {
          throw new Error("MANDATE_APPROVE: wu_sequence entries must be non-empty strings.")
        }
        state.mandate.wu_sequence = [...body.wu_sequence]
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

    case "MANDATE_AMEND": {
      if (!state.mandate) throw new Error("MANDATE_AMEND requires an approved mandate.")
      if (state.mandate.authority_kind !== MANDATE_AUTHORITY.OWNER_APPROVED_EPIC) {
        throw new Error("MANDATE_AMEND requires an OWNER_APPROVED_EPIC mandate.")
      }
      if (state.completed) throw new Error("MANDATE_AMEND cannot modify a completed execution.")
      if (state.merge) throw new Error("MANDATE_AMEND cannot modify policy after a merge has started or been recorded.")
      if (!body.mandate_id || body.mandate_id !== state.mandate.mandate_id) {
        throw new Error(`MANDATE_AMEND mandate mismatch: ${body.mandate_id ?? "missing"} vs ${state.mandate.mandate_id}.`)
      }
      if (body.max_wus !== state.mandate.max_wus) {
        throw new Error(`MANDATE_AMEND cannot change max_wus: ${state.mandate.max_wus} -> ${body.max_wus}.`)
      }
      if (body.total_seconds !== state.budget.total_seconds) {
        throw new Error(`MANDATE_AMEND cannot change total_seconds: ${state.budget.total_seconds} -> ${body.total_seconds}.`)
      }

      const currentPolicy = state.mandate.merge_policy ?? "none"
      const currentChecks = state.mandate.required_ci_checks ?? []
      const expectedPolicy = body.expected_merge_policy ?? "none"
      const expectedChecks = body.expected_required_ci_checks ?? []
      if (currentPolicy !== expectedPolicy || !setsEqual(currentChecks, expectedChecks)) {
        throw new Error("MANDATE_AMEND expected policy does not match current effective mandate policy.")
      }

      const nextPolicy = body.merge_policy ?? "none"
      const nextChecks = body.required_ci_checks
      if (!MERGE_POLICIES.includes(nextPolicy)) {
        throw new Error(`MANDATE_AMEND: unknown merge_policy ${nextPolicy}.`)
      }
      if (!Array.isArray(nextChecks) || nextChecks.some((check) => typeof check !== "string" || check.length === 0)) {
        throw new Error("MANDATE_AMEND requires an array of non-empty required_ci_checks identifiers.")
      }
      if (new Set(nextChecks).size !== nextChecks.length) {
        throw new Error("MANDATE_AMEND required_ci_checks cannot contain duplicates.")
      }
      if (!body.source_artifact_id || !body.source_record_key || !body.source_hash) {
        throw new Error("MANDATE_AMEND requires source_artifact_id, source_record_key, and source_hash.")
      }

      state.mandate.merge_policy = nextPolicy
      state.mandate.required_ci_checks = [...nextChecks]
      state.mandate.policy_revision = body.source_revision ?? null
      state.mandate.policy_source_artifact_id = body.source_artifact_id
      state.mandate.policy_source_record_key = body.source_record_key
      state.mandate.policy_source_hash = body.source_hash
      state.mandate.policy_amendment_count = (state.mandate.policy_amendment_count ?? 0) + 1
      state.mandate.last_policy_amendment = {
        previous_merge_policy: currentPolicy,
        previous_required_ci_checks: [...currentChecks],
        merge_policy: nextPolicy,
        required_ci_checks: [...nextChecks],
        source_artifact_id: body.source_artifact_id,
        source_record_key: body.source_record_key,
        source_hash: body.source_hash,
        source_revision: body.source_revision ?? null,
        at_revision: state.revision,
      }

      // Retire the exact bound candidate's obsolete CI wait when an owner-
      // approved amendment explicitly removes all required checks. The
      // original event remains in the append-only log; no CI PASS is invented.
      if (currentChecks.length > 0 && nextPolicy === "governed_auto" && nextChecks.length === 0) {
        const candidateId = state.pr_binding?.candidate_id
        const isBoundCiWait = wait => Boolean(candidateId && wait?.kind === "CI_PENDING" &&
          ["harness_merge_candidate:", "harness_verify_external_merge:"].some(prefix => wait.operation === prefix + candidateId))
        if (isBoundCiWait(state.external_wait)) {
          state.external_wait_history ??= []
          state.external_wait_history.push({ ...state.external_wait, outcome: "SUPERSEDED_BY_POLICY",
            ended_at: event.timestamp, ended_at_revision: state.revision,
            source_artifact_id: body.source_artifact_id, source_hash: body.source_hash })
          state.external_wait = null
        }
        // Recover only an expired blocker proven to be the same obsolete CI wait.
        const expired = expiredWait(state)
        if (isBoundCiWait(expired)) {
          state.last_blocker_resolution = {
            class: state.blocker.class, blocked_at_revision: state.blocker.at_revision,
            resolution: "Bound CI wait superseded by approved no-CI mandate",
            source_artifact_id: body.source_artifact_id, source_hash: body.source_hash,
            at_revision: state.revision,
          }
          state.blocker = null
        }
      }
      break
    }

    case "TIME_POLICY_ADOPT": {
      if (state.completed || !state.mandate || body.mode !== PLANNING_ESTIMATES) throw new Error("Invalid time policy transition")
      if (`${body.execution_id}:exec` !== state.execution_id || body.mandate_id !== state.mandate.mandate_id || body.epic_total_seconds !== state.budget.total_seconds) throw new Error("Time policy authority target mismatch")
      if (!body.source_artifact_id || !body.source_record_key || !/^[a-f0-9]{64}$/.test(body.source_hash ?? "")) throw new Error("Time policy requires approved decision provenance")
      if (state.budget.active_phase || Object.values(state.dispatches).some(d => ![DISPATCH_STATUS.RESULT_RECONCILED, DISPATCH_STATUS.ABANDONED_RECONCILED, DISPATCH_STATUS.RELEASED].includes(d.status))) throw new Error("Settle existing dispatches and phases before adopting the time policy")
      if ((state.blocker?.at_revision ?? null) !== body.blocked_at_revision) throw new Error("Time policy blocker baseline changed")
      if (state.blocker && state.blocker.class !== "BUDGET_EXHAUSTED") throw new Error("Time policy cannot resolve an unrelated blocker")
      state.time_policy = { ...body, at_revision: state.revision }
      if (state.blocker && deriveBudget(state.budget).available_seconds > 0) {
        state.last_blocker_resolution = { ...state.blocker, blocked_at_revision: state.blocker.at_revision,
          resolution: "Owner-approved WU planning estimates; Epic budget preserved", source_hash: body.source_hash, at_revision: state.revision }
        state.blocker = null
      }
      break
    }

    case "WU_BUDGET_AMEND": {
      if (state.completed || !state.wu || state.wu.completed) throw new Error("WU_BUDGET_AMEND requires an active incomplete WU")
      if (state.mandate?.authority_kind !== MANDATE_AUTHORITY.OWNER_APPROVED_EPIC || body.mandate_id !== state.mandate.mandate_id || body.wu_id !== state.wu.wu_id || `${body.execution_id}:exec` !== state.execution_id) {
        throw new Error("WU_BUDGET_AMEND authority does not match this execution, mandate and active WU")
      }
      if (state.blocker?.class !== "BUDGET_EXHAUSTED" || body.blocked_at_revision !== state.blocker.at_revision) throw new Error("WU_BUDGET_AMEND must target the exact active BUDGET_EXHAUSTED blocker")
      if (!body.source_artifact_id || !body.source_record_key || !/^[a-f0-9]{64}$/.test(body.source_hash ?? "")) throw new Error("WU_BUDGET_AMEND requires approved decision provenance")
      if (body.epic_total_seconds !== state.budget.total_seconds) throw new Error("WU_BUDGET_AMEND cannot change the Epic total")
      const usage = wuBudgetUsage(state, body.wu_id)
      if (state.budget.active_phase || Object.values(state.dispatches).some(d => d.wu_id === body.wu_id && ![DISPATCH_STATUS.RESULT_RECONCILED, DISPATCH_STATUS.ABANDONED_RECONCILED, DISPATCH_STATUS.RELEASED].includes(d.status))) {
        throw new Error("WU_BUDGET_AMEND requires settled WU dispatches and no active phase")
      }
      if (body.expected_used_seconds !== usage.used_seconds) throw new Error("WU_BUDGET_AMEND stale consumed budget baseline")
      if (!Number.isSafeInteger(body.additional_seconds) || body.additional_seconds <= 0 || !Number.isSafeInteger(usage.used_seconds + body.additional_seconds)) throw new Error("WU_BUDGET_AMEND requires a finite positive integer allocation")
      if (body.additional_seconds > deriveBudget(state.budget).available_seconds) throw new Error("WU_BUDGET_AMEND allocation exceeds available Epic budget")
      const ceiling = usage.used_seconds + body.additional_seconds
      if (usage.ceiling_seconds !== null && ceiling <= usage.ceiling_seconds) throw new Error("WU_BUDGET_AMEND must increase the existing WU ceiling")
      state.wu_budget_amendments ??= {}
      state.wu_budget_amendments[body.wu_id] = { ...body, ceiling_seconds: ceiling, at_revision: state.revision }
      state.last_blocker_resolution = { class: state.blocker.class, blocked_at_revision: state.blocker.at_revision,
        resolution: `Owner-approved WU budget amendment ${body.source_artifact_id}`, source_hash: body.source_hash, at_revision: state.revision }
      state.blocker = null
      break
    }

    case "WU_CONTRACT_CORRECT": {
      validateContractCorrection(state, body)
      state.contract_corrections ??= []
      state.contract_corrections.push({ ...body, previous_contract: state.wu.contract, at_revision: state.revision })
      for (const candidate of Object.values(state.candidates)) {
        if (candidate.wu_id === state.wu.wu_id) candidate.superseded_by_contract = body.contract.contract_hash
      }
      state.wu.contract = body.contract
      // Keep historical PR, CI and review receipts, but require a new binding.
      state.pr_binding = null
      break
    }

    case "WU_CONTRACT_STAGE": {
      if (body.expected_revision !== state.revision) throw new Error("WU_CONTRACT_STAGE stale expected_revision")
      if (state.completed || state.mandate?.authority_kind !== MANDATE_AUTHORITY.OWNER_APPROVED_EPIC) {
        throw new Error("WU_CONTRACT_STAGE requires an incomplete owner-approved Epic")
      }
      if (state.blocker && state.blocker.class !== "BLOCKED_AUTHORITY") {
        throw new Error("WU_CONTRACT_STAGE cannot bypass an unrelated blocker")
      }
      if (state.wu && !state.wu.completed) throw new Error("WU_CONTRACT_STAGE requires the preceding WU to be completed")
      if (processPending(state)) throw new Error("WU_CONTRACT_STAGE blocked by pending process recovery")
      if (state.staged_wu_contract) throw new Error("WU_CONTRACT_STAGE already staged a contract; conflicting revisions require explicit reconciliation")
      if (!Array.isArray(state.mandate.wu_sequence)) throw new Error("WU_CONTRACT_STAGE requires a frozen WU sequence")
      if (state.activated_wu_ids.length >= state.mandate.max_wus) throw new Error("WU_CONTRACT_STAGE exceeds max_wus")
      const expected = state.mandate.wu_sequence[state.activated_wu_ids.length]
      if (!expected || body.wu_id !== expected || state.activated_wu_ids.includes(body.wu_id)) {
        throw new Error(`WU_CONTRACT_STAGE next frozen WU is ${expected ?? "none"}, not ${body.wu_id}`)
      }
      const contract = body.contract
      const delegated = body.derived_technical === true
      const authorized = delegated
        ? contract?.source_authority === "MANDATE_DERIVED" && state.time_policy?.mode === PLANNING_ESTIMATES &&
          contract.mandate_source_hash === state.mandate.source_hash &&
          contract.origin_source_hash === contract.source_hash &&
          Boolean(contract.source_record_key)
        : contract?.source_authority === "APPROVED"
      if (!contract || contract.wu_id !== body.wu_id || contract.normalization_required ||
        !contract.verification_contract_hash || !authorized ||
        !contract.source_record_key || !/^[a-f0-9]{64}$/.test(contract.source_hash ?? "") ||
        !Number.isSafeInteger(contract.active_seconds) || contract.active_seconds <= 0 ||
        !contract.contract_hash || typeof contract.source_content !== "string") {
        throw new Error("WU_CONTRACT_STAGE requires an exact approved executable contract")
      }
      if (state.blocker?.class === "BLOCKED_AUTHORITY" && !Number.isSafeInteger(state.blocker.at_revision)) {
        throw new Error("WU_CONTRACT_STAGE requires an auditable authority blocker revision")
      }
      if (delegated) {
        const { contract_hash, ...identity } = contract
        if (stableHash(identity) !== contract_hash ||
            contract.derivation?.kind !== "MANDATE_JIT" ||
            contract.derivation.original_source_hash !== contract.source_hash ||
            sha256(contract.source_content) !== contract.source_hash) {
          throw new Error("JIT derived contract integrity mismatch")
        }
      }
      if (delegated && state.blocker &&
        (!isTechnicalWuContractBlocker(state.blocker) || body.blocker_at_revision !== state.blocker.at_revision)) {
        throw new Error("JIT may resolve only the exact technical contract-normalization blocker")
      }
      if (delegated && !state.blocker && body.blocker_at_revision !== null) throw new Error("JIT blocker revision drift")
      state.staged_wu_contract = { wu_id: body.wu_id, source_artifact_id: body.source_artifact_id, contract, staged_at_revision: state.revision,
        blocker_at_revision: state.blocker?.at_revision ?? null }
      if (delegated && state.blocker) {
        state.last_blocker_resolution = { class: state.blocker.class,
          blocked_at_revision: state.blocker.at_revision,
          resolution: "Mandate-derived technical normalization; no owner approval asserted",
          source_record_key: contract.source_record_key,
          source_hash: contract.source_hash, at_revision: state.revision }
        state.blocker = null
      }
      break
    }

    case "WU_CONTRACT_BIND": {
      if (!state.wu || state.wu.completed || body.contract?.wu_id !== state.wu.wu_id) throw new Error("WU contract target mismatch")
      const old = state.wu.contract
      if (old && (old.verification_contract_hash || old.active_seconds !== body.contract.active_seconds || !body.contract.source_content.includes(old.source_content)))
        throw new Error("WU normalization must preserve the original source and budget; an executable contract cannot be silently replaced")
      state.wu.contract = body.contract
      break
    }

    case "WU_ACTIVATE": {
      if (processPending(state)) throw new Error("Finish process recovery before advancing WUs")
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
      if (Array.isArray(state.mandate.wu_sequence)) {
        const expectedWu = state.mandate.wu_sequence[state.activated_wu_ids.length]
        if (!expectedWu) {
          throw new Error("WU_ACTIVATE blocked: frozen Epic WU sequence is exhausted; EPIC_REBASE_REQUIRED.")
        }
        if (body.wu_id !== expectedWu) {
          throw new Error(`WU_ACTIVATE blocked: next frozen WU is ${expectedWu}, got ${body.wu_id}; successor creation/reordering is not authorized.`)
        }
      }
      if (state.staged_wu_contract) {
        const staged = state.staged_wu_contract
        if (staged.wu_id !== body.wu_id || !body.contract ||
            body.contract.contract_hash !== staged.contract.contract_hash ||
            body.contract.source_record_key !== staged.contract.source_record_key ||
            body.contract.source_hash !== staged.contract.source_hash ||
            stableHash(body.contract) !== stableHash(staged.contract)) {
          throw new Error("WU_ACTIVATE must use the exact preactivation-staged approved contract")
        }
        if (state.blocker) throw new Error("WU_ACTIVATE requires the preactivation authority blocker to be resolved")
      }
      state.wu = {
        wu_id: body.wu_id,
        mandate_id: state.mandate.mandate_id,
        mandate_revision: state.mandate.mandate_revision,
        origin: WU_ORIGIN.DERIVED,
        execution_authorization: EXECUTION_AUTHORIZATION.AUTHORIZED_BY_MANDATE,
        completed: false,
        ...(body.contract ? { contract: body.contract } : {}),
      }
      state.activated_wu_ids.push(body.wu_id)
      if (state.staged_wu_contract) delete state.staged_wu_contract
      break
    }

    case "PHASE_START": {
      if (state.budget.active_phase) throw new Error("Cannot start a phase while another is active.")
      if (!body.phase) throw new Error("PHASE_START requires a phase.")
      state.active_phase_wu_id = state.wu?.wu_id ?? null
      state.budget.active_phase = body.phase
      state.budget.active_started_at = body.started_at
      if (body.source === "runtime.verification") state.verification_phase = { operation_id: event.operation_id, session_id: body.session_id,
        owner_pid: body.owner_pid, owner_death_guard: body.owner_death_guard, authorized_seconds: body.authorized_seconds }
      break
    }

    case "PHASE_END": {
      if (!state.budget.active_phase) throw new Error("Cannot end a phase when none is active.")
      if (state.verification_phase && body.expected_phase_id !== state.verification_phase.operation_id) throw new Error("Cannot settle another verification phase")
      const started = state.budget.active_started_at
      const ended = body.ended_at
      if (!Number.isFinite(ended)) throw new Error("PHASE_END requires a finite ended_at.")
      if (BILLABLE_PHASES.has(state.budget.active_phase)) {
        const charged = Math.max(0, ended - started)
        state.budget.used_seconds += charged
        if (state.active_phase_wu_id) {
          state.wu_phase_seconds ??= {}
          const phaseWu = state.active_phase_wu_id
          state.wu_phase_seconds[phaseWu] = (state.wu_phase_seconds[phaseWu] ?? 0) + charged
        }
      }
      delete state.active_phase_wu_id
      delete state.verification_phase
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
      if (body.process_review_candidate_id) d.prepared_process_candidate_id = body.process_review_candidate_id
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
      if (d.expected_agent === 'harness-reviewer' && activeRecovery(state)) {
        d.process_review_candidate_id = d.prepared_process_candidate_id ?? null
        d.process_evidence_hash = stableHash(activeRecovery(state).evidence)
      }
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

    case "DISPATCH_HANDOFF": {
      const d = state.dispatches[body.dispatch_id]
      if (!d || d.session_id !== body.session_id || d.launch_call_id !== body.call_id) throw new Error("Handoff identity mismatch")
      if (d.fence) throw new Error("Fenced dispatch cannot accept a late success handoff")
      if (d.handoff) throw new Error("Handoff already recorded")
      d.handoff = { content: body.content, content_hash: body.content_hash, truncated: body.truncated,
        source: "execute.after", acceptance: "UNVERIFIED", at_revision: state.revision }
      break
    }

    case "DISPATCH_USAGE": {
      const d = state.dispatches[body.dispatch_id]
      if (!d || d.status !== DISPATCH_STATUS.LAUNCHED || d.session_id !== body.session_id || d.launch_call_id !== body.call_id) throw new Error("Runtime usage identity mismatch")
      if (d.fence) throw new Error("Fenced dispatch cannot accept post-fence runtime usage")
      if (d.usage) throw new Error("Runtime usage already captured")
      if (body.source !== "runtime.monotonic_dispatch_envelope" || !Number.isFinite(body.seconds) || body.seconds < 0) throw new Error("Invalid runtime usage")
      d.usage = { seconds: body.seconds, source: body.source, call_id: body.call_id, at_revision: state.revision }
      break
    }

    case "DISPATCH_FINISH": {
      const d = state.dispatches[body.dispatch_id]
      if (!d || d.status !== DISPATCH_STATUS.LAUNCHED) throw new Error(`Cannot finish dispatch ${body.dispatch_id}: not launched.`)
      if (d.fence) throw new Error("Fenced dispatch cannot be recorded as conventionally finished")
      d.status = DISPATCH_STATUS.FINISHED
      d.result = body.result ?? null
      break
    }

    case "DISPATCH_FENCE": {
      const d = state.dispatches[body.dispatch_id]
      if (!d || d.status !== DISPATCH_STATUS.LAUNCHED || d.reservation_status !== RESERVATION_STATUS.RESERVED ||
          !d.claim_required || !d.launch_call_id || !d.session_id ||
          !d.prepared_by_session_id || !d.expected_agent || !d.wu_id ||
          body.child_session_id !== d.session_id || body.parent_session_id !== d.prepared_by_session_id ||
          body.launch_call_id !== d.launch_call_id || body.agent !== d.expected_agent || body.wu_id !== d.wu_id ||
          body.expected_revision !== state.revision || d.fence ||
          body.proof?.kind !== "VERIFIED_QUIESCENT_CHILD" ||
          body.proof.child_session_id !== d.session_id ||
          body.proof.parent_session_id !== d.prepared_by_session_id ||
          body.proof.launch_call_id !== d.launch_call_id ||
          body.proof.agent !== d.expected_agent ||
          body.proof.runtime_quiescent !== true || body.proof.pending_tools !== 0 ||
          body.proof.interrupted !== true || body.proof.fence_hook_installed !== true ||
          typeof body.proof.observation_hash !== "string" || !/^[a-f0-9]{64}$/.test(body.proof.observation_hash)) {
        throw new Error("DISPATCH_FENCE requires a live root-sourced exact-identity quiescence proof and matching revision")
      }
      d.fence = { child_session_id: d.session_id, generation: state.revision + 1,
        proof: structuredClone(body.proof), at_revision: state.revision, timestamp: event.timestamp }
      break
    }

    case "DISPATCH_ABANDON": {
      const d = state.dispatches[body.dispatch_id]
      if (!d || d.status !== DISPATCH_STATUS.LAUNCHED || !d.fence ||
          d.fence.child_session_id !== body.child_session_id ||
          body.fence_generation !== d.fence.generation ||
          body.proof?.kind !== "POST_FENCE_QUIESCENCE" ||
          body.proof.child_session_id !== d.session_id ||
          body.proof.pending_tools !== 0 || body.proof.runtime_quiescent !== true ||
          body.proof.fence_enforced !== true ||
          typeof body.proof.observation_hash !== "string" || !/^[a-f0-9]{64}$/.test(body.proof.observation_hash)) {
        throw new Error("DISPATCH_ABANDON requires enforced durable fencing and fresh post-fence quiescence")
      }
      d.status = DISPATCH_STATUS.ABANDONED
      d.abandonment = { reason: "ORPHANED_INTERRUPTED", evidence: structuredClone(body.proof), at_revision: state.revision }
      break
    }

    case "DISPATCH_RECONCILE_ABANDONED": {
      const d = state.dispatches[body.dispatch_id]
      if (!d || d.status !== DISPATCH_STATUS.ABANDONED ||
          d.reservation_status !== RESERVATION_STATUS.RESERVED || !d.fence ||
          body.fence_generation !== d.fence.generation) {
        throw new Error("DISPATCH_RECONCILE_ABANDONED requires a fenced, abandoned, unsettled dispatch")
      }
      // A zero-length reservation cannot account for an unknown runtime. A
      // measured envelope may exceed the original reservation, leaving visible debt.
      const recorded = d.usage?.seconds
      const charge = Math.max(d.reserved_seconds, recorded ?? 0)
      if (!Number.isFinite(charge) || charge <= 0) throw new Error("Unknown orphan consumption requires a positive conservative reservation")
      d.status = DISPATCH_STATUS.ABANDONED_RECONCILED
      d.reservation_status = RESERVATION_STATUS.CONSUMED
      d.actual_consumption = charge
      d.consumption_basis = recorded == null ? "conservative_orphan_reservation" : "max_observed_envelope_or_reservation"
      d.reconciled = { verdict: "ABANDONED_NOT_SUCCESS", evidence: d.abandonment.evidence, at_revision: state.revision }
      state.budget.reserved_seconds -= d.reserved_seconds
      state.budget.used_seconds += charge
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
      const actual = reported === undefined || reported === null ? (d.usage?.seconds ?? reserved) : reported
      if (!Number.isFinite(actual) || actual < 0) throw new Error("DISPATCH_RECONCILE actual_consumption must be a finite non-negative number.")
      if (actual > reserved && !d.usage) throw new Error(`DISPATCH_RECONCILE consumption ${actual} exceeds reservation ${reserved}; overrun requires an explicit transition, never a silent adjustment.`)
      d.status = DISPATCH_STATUS.RESULT_RECONCILED
      d.reservation_status = RESERVATION_STATUS.CONSUMED
      d.actual_consumption = actual
      d.consumption_basis = d.usage ? "observed_wall_upper_bound" : (reported == null ? "conservative_reservation" : "legacy_reported")
      d.reconciled = { verdict: body.verdict ?? null, evidence: body.evidence ?? null, at_revision: state.revision }
      state.budget.reserved_seconds -= reserved
      state.budget.used_seconds += actual
      if (state.blocker?.class === "BUDGET_EXHAUSTED" && state.blocker.budget_reason === "reservation_expired" && state.blocker.dispatch_id === body.dispatch_id) {
        const remainingWu = wuBudgetUsage(state, d.wu_id).available_seconds
        if (remainingWu > 0 && deriveBudget(state.budget).available_seconds > 0) {
          state.last_blocker_resolution = { class: state.blocker.class, blocked_at_revision: state.blocker.at_revision,
            resolution: "Reservation settled; unused authorized WU allocation remains", at_revision: state.revision }
          state.blocker = null
        }
      }
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

    case "DISPATCH_RESOLVE_AMBIGUOUS_LAUNCH": {
      const d = state.dispatches[body.dispatch_id]
      if (!d) throw new Error(`Cannot resolve unknown dispatch ${body.dispatch_id}.`)
      if (d.status !== DISPATCH_STATUS.AMBIGUOUS) {
        throw new Error(`Cannot resolve ambiguous launch for dispatch ${body.dispatch_id}: status is ${d.status}, not ambiguous.`)
      }
      if (!body.session_id || typeof body.session_id !== "string") {
        throw new Error("DISPATCH_RESOLVE_AMBIGUOUS_LAUNCH requires the exact recovered external session_id.")
      }
      if (!body.recovery_evidence || typeof body.recovery_evidence !== "string" || body.recovery_evidence.trim().length === 0) {
        throw new Error("DISPATCH_RESOLVE_AMBIGUOUS_LAUNCH requires non-empty recovery_evidence.")
      }
      if (d.session_id) {
        throw new Error(`Cannot resolve ambiguous launch for dispatch ${body.dispatch_id}: session identity is already set.`)
      }
      d.status = DISPATCH_STATUS.LAUNCHED
      d.session_id = body.session_id
      d.ambiguous_launch_recovery = {
        session_id: body.session_id,
        recovery_evidence: body.recovery_evidence,
        at_revision: state.revision,
      }
      // Reservation remains held exactly as it was. Normal record_finish ->
      // reconcile settles it once the recovered launched session is accounted for.
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
        wu_contract_hash: body.wu_contract_hash ?? null,
        ...(requiresTdd(state) ? { process_recorded_revision: state.revision } : {}),
      }
      break
    }

    case "RECORD_REVIEW": {
      const candidate = state.candidates[body.candidate_id]
      if (candidate?.superseded_by_contract) throw new Error("Candidate contract superseded; refreeze and obtain fresh review")
      if (!candidate) throw new Error(`Cannot review unknown candidate ${body.candidate_id}.`)
      const hashes = body.candidate_hashes ?? {}
      if (hashes.manifest_hash !== candidate.manifest_hash || hashes.tree_hash !== candidate.tree_hash) {
        throw new Error(`Review hash mismatch for candidate ${body.candidate_id}: a review cannot accredit a different candidate.`)
      }
      const evidenceIds = body.verification_evidence_ids ?? []
      const verifiedCheckIds = body.verified_check_ids ?? []
      if (body.verdict === "PASS") {
        assertProcessAcceptance(state, body.candidate_id)
        // Older logs may contain PASS reviews without receipts. Preserve the
        // exact historical projection, but never accept a NEW receiptless PASS.
        if (!historicalReplay && evidenceIds.length === 0) throw new Error("RECORD_REVIEW: a PASS verdict requires verification evidence.")
        if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error("RECORD_REVIEW: duplicate evidence ids in a PASS verdict.")
        if (new Set(verifiedCheckIds).size !== verifiedCheckIds.length) throw new Error("RECORD_REVIEW: duplicate check coverage in a PASS verdict.")
        if (!setsEqual(verifiedCheckIds, candidate.required_check_ids ?? [])) {
          throw new Error(`RECORD_REVIEW: PASS requires full verification coverage (verified ${verifiedCheckIds.join(",") || "none"}, required ${(candidate.required_check_ids ?? []).join(",") || "none"}).`)
        }
        if ((body.verification_contract_hash ?? null) !== (candidate.verification_contract_hash ?? null)) {
          throw new Error("RECORD_REVIEW: verification contract hash mismatch.")
        }
      }
      state.review_history ??= {}
      state.review_history[body.candidate_id] ??= []
      if (state.reviews[body.candidate_id]) state.review_history[body.candidate_id].push(state.reviews[body.candidate_id])
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
      state.blocker = { ...(body.authority_question ? { authority_question: body.authority_question } : {}), ...(body.scope_cause ? { scope_cause: body.scope_cause } : {}), ...(body.kind ? { kind: body.kind } : {}), class: body.class, reason: body.reason ?? null, at_revision: state.revision, ...(body.class === "NO_PROGRESS" ? { progress_hash: executionProgress(state) } : {}), ...(["reservation_expired", "epic_exhausted"].includes(body.budget_reason) ? { budget_reason: body.budget_reason, dispatch_id: body.dispatch_id } : {}) }
      break
    }

    case "AUTHORITY_RESOLVE": {
      const activeTarget = state.wu && !state.wu.completed && body.wu_id === state.wu.wu_id
      const stagedTarget = (!state.wu || state.wu.completed) &&
        state.staged_wu_contract?.wu_id === body.wu_id
      if (state.completed || (!activeTarget && !stagedTarget)) {
        throw new Error("AUTHORITY_RESOLVE target must match the active WU or a preactivation-staged next WU")
      }
      if (state.mandate?.authority_kind !== MANDATE_AUTHORITY.OWNER_APPROVED_EPIC || body.mandate_id !== state.mandate.mandate_id || `${body.execution_id}:exec` !== state.execution_id) {
        throw new Error("AUTHORITY_RESOLVE must match the execution, mandate and active WU")
      }
      if (state.blocker?.class !== "BLOCKED_AUTHORITY" || body.blocked_at_revision !== state.blocker.at_revision) throw new Error("AUTHORITY_RESOLVE must target the exact active BLOCKED_AUTHORITY blocker")
      if (!body.source_artifact_id || !body.source_record_key || !/^[a-f0-9]{64}$/.test(body.source_hash ?? "") || typeof body.decision_content !== "string" || !body.decision_content.trim() || typeof body.resolution !== "string" || !body.resolution.trim()) {
        throw new Error("AUTHORITY_RESOLVE requires approved decision provenance, content and resolution")
      }
      state.authority_resolutions ??= {}
      state.authority_resolutions[body.wu_id] ??= []
      if (stagedTarget && state.staged_wu_contract.blocker_at_revision !== state.blocker.at_revision) {
        throw new Error("AUTHORITY_RESOLVE preactivation blocker changed after contract staging")
      }
      const receipt = { ...body, blocker_reason: state.blocker.reason, at_revision: state.revision,
        ...(stagedTarget ? { preactivation_contract_hash: state.staged_wu_contract.contract.contract_hash } : {}) }
      state.authority_resolutions[body.wu_id].push(receipt)
      state.last_blocker_resolution = { class: state.blocker.class, blocked_at_revision: state.blocker.at_revision,
        resolution: body.resolution, source_artifact_id: body.source_artifact_id, source_record_key: body.source_record_key,
        source_hash: body.source_hash, at_revision: state.revision }
      state.blocker = null
      break
    }

    case "SCOPE_WORKTREE_RECONCILE": {
      const blocker = state.blocker
      if (!isStaleWorktreeScopeBlocker(blocker) ||
          body.blocked_at_revision !== blocker.at_revision ||
          body.wu_id !== state.wu?.wu_id || state.wu.completed ||
          state.mandate?.authority_kind !== MANDATE_AUTHORITY.OWNER_APPROVED_EPIC ||
          body.proof?.kind !== "VERIFIED_PREDECESSOR_WORKTREE" ||
          body.proof.wu_id !== body.wu_id || body.proof.blocked_at_revision !== blocker.at_revision ||
          !/^[a-f0-9]{40}$/.test(body.proof.head_sha ?? "") ||
          body.proof.head_sha !== body.proof.predecessor_merge_sha ||
          !Array.isArray(body.proof.predecessor_files) || body.proof.predecessor_files.length === 0) {
        throw new Error("SCOPE_WORKTREE_RECONCILE requires the exact stale-worktree blocker and verified predecessor provenance")
      }
      if (state.budget.active_phase || state.external_wait || state.verification_phase ||
          Object.values(state.dispatches).some(d => !["released", "result_reconciled", "abandoned_reconciled"].includes(d.status)) ||
          Object.values(state.candidates).some(c => c.wu_id === state.wu.wu_id)) {
        throw new Error("SCOPE_WORKTREE_RECONCILE rejects unsettled or already frozen active work")
      }
      const index = state.activated_wu_ids.length - 1
      const previousWu = state.mandate.wu_sequence?.[index - 1]
      const previous = state.completed_wus?.[previousWu]
      const merge = state.merge?.candidate_id === previous?.candidate_id ? state.merge : state.merges?.[previous?.candidate_id]
      if (!previousWu || previous?.candidate_id !== body.proof.predecessor_candidate_id ||
          !merge || merge.status !== "VERIFIED" ||
          merge.merge_commit_sha !== body.proof.predecessor_merge_sha ||
          new Set(body.proof.predecessor_files.map(f => f.path)).size !== body.proof.predecessor_files.length ||
          body.proof.predecessor_files.some(f => !f.path || !/^[a-f0-9]{64}$/.test(f.sha256 ?? ""))) {
        throw new Error("SCOPE_WORKTREE_RECONCILE predecessor merge/evidence mismatch")
      }
      state.last_blocker_resolution = { class: blocker.class,
        blocked_at_revision: blocker.at_revision,
        resolution: "Verified stale-worktree discrepancy resolved at exact prior merged Git HEAD; no scope or authority amendment",
        proof: body.proof, at_revision: state.revision }
      state.blocker = null
      break
    }

    case "VERIFICATION_RETRY_ATTEMPT": {
      const blocker = state.blocker
      const wu = state.wu
      if (state.completed || blocker?.class !== "BLOCKED_TOOLING" ||
          blocker.at_revision !== body.blocked_at_revision ||
          !wu || wu.completed || wu.wu_id !== body.wu_id ||
          body.candidate_id == null || state.candidates[body.candidate_id]?.wu_id !== wu.wu_id ||
          !wu.contract?.verification_contract?.commands?.some(c => c.id === body.check_id) ||
          typeof body.failure_evidence_id !== "string" ||
          !/^verify-[a-f0-9]{64}$/.test(body.failure_evidence_id) ||
          body.verification_contract_hash !== wu.contract.verification_contract_hash ||
          state.verification_phase || state.budget.active_phase ||
          Object.values(state.dispatches).some(d => !["released", "result_reconciled", "abandoned_reconciled"].includes(d.status))) {
        throw new Error("VERIFICATION_RETRY_ATTEMPT requires matching active WU, frozen check, failure receipt and exact tooling blocker")
      }
      if (state.verification_retry?.blocked_at_revision === blocker.at_revision) {
        throw new Error("VERIFICATION_RETRY_ALREADY_ATTEMPTED: one retry per exact tooling blocker")
      }
      state.verification_retry = { ...body, at_revision: state.revision }
      break
    }

    case "CLEAR_BLOCKER": {
      if (state.blocker?.class === "NO_PROGRESS" && state.blocker.progress_hash === executionProgress(state)) throw new Error("NO_PROGRESS requires new durable execution evidence; a resolution string or checkpoint is insufficient")
      if (!state.blocker) throw new Error("CLEAR_BLOCKER requires an active blocker.")
      if (!RECOVERABLE_BLOCKER_CLASSES.has(state.blocker.class)) {
        throw new Error(`CLEAR_BLOCKER cannot clear non-recoverable blocker ${state.blocker.class}.`)
      }
      if (body.blocker_class !== state.blocker.class || body.blocked_at_revision !== state.blocker.at_revision) {
        throw new Error("CLEAR_BLOCKER target does not match the active blocker.")
      }
      if (typeof body.resolution !== "string" || body.resolution.trim().length === 0) {
        throw new Error("CLEAR_BLOCKER requires a non-empty resolution.")
      }
      state.last_blocker_resolution = {
        class: state.blocker.class,
        blocked_at_revision: state.blocker.at_revision,
        resolution: body.resolution,
        ...(body.recovery_evidence ? { recovery_evidence: body.recovery_evidence } : {}),
        at_revision: state.revision,
      }
      state.blocker = null
      break
    }

    case "BIND_PR": {
      const candidate = state.candidates[body.candidate_id]
      if (candidate?.superseded_by_contract) throw new Error("Candidate contract superseded; refreeze and obtain fresh review")
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
          const previousCandidate = state.candidates[existing.candidate_id]
          const priorComplete = state.completed_wus?.[previousCandidate?.wu_id]
          const sameWuReplacement = previousCandidate?.wu_id === candidate.wu_id && !state.merge
          const completedPredecessor = priorComplete && (!state.merge ||
            (state.merge.status === "VERIFIED" && state.merge.candidate_id === existing.candidate_id))
          const revalidated = body.revalidated === true && existing.candidate_id === binding.candidate_id && !state.merge &&
            existing.repository === binding.repository && existing.pr_number === binding.pr_number && /^[a-f0-9]{40}$/.test(body.tree_sha ?? "")
          if ((!revalidated && (existing.candidate_id === binding.candidate_id || state.pr_bindings?.[binding.candidate_id])) ||
              !state.wu || state.wu.completed || state.reviews[binding.candidate_id]?.verdict !== "PASS" ||
              (!sameWuReplacement && !completedPredecessor)) {
            throw new Error(`BIND_PR: already bound to repository ${existing.repository} PR #${existing.pr_number} head ${existing.head_sha}; replacement requires a new reviewed candidate and a settled predecessor (no merge in progress).`)
          }
          // Archive is retained below/on earlier events. Selecting a new candidate
          // must never inherit the previous candidate's verified merge.
          state.binding_history ??= []
          state.binding_history.push(existing)
          if (revalidated) delete state.ci_evidence[binding.candidate_id]
          state.merge = null
        }
      }
      state.pr_binding = binding
      break
    }

    case "RECORD_CI": {
      const candidate = state.candidates[body.candidate_id]
      if (candidate?.superseded_by_contract) throw new Error("Candidate contract superseded; refreeze and obtain fresh review")
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
        binding_at_revision: body.binding_at_revision ?? null,
        observed_at: event.timestamp,
      }
      break
    }

    case "MERGE_SUPERSEDE": {
      // Append-only reconciliation of a defect left by an older projection: when a
      // WU completed, its settled merge pointer could survive into the next WU if
      // the intermediate binding was invalidated (a contract correction clears
      // `pr_binding` without touching `state.merge`). That stale pointer makes the
      // successor candidate's merge/verify fail closed with "merge belongs to a
      // different candidate". This event retires ONLY a settled VERIFIED merge
      // that belongs to a *completed predecessor* WU, for the candidate currently
      // bound. It never performs a merge, never invents ownership and never
      // touches an unresolved attempt.
      const stale = state.merge
      if (!stale) throw new Error("MERGE_SUPERSEDE requires an existing merge pointer.")
      if (stale.status !== "VERIFIED") throw new Error(`MERGE_SUPERSEDE refused: merge ${stale.status} is not settled; resolve the attempt instead.`)
      const binding = state.pr_binding
      if (!binding) throw new Error("MERGE_SUPERSEDE requires a current PR binding.")
      if (binding.candidate_id === stale.candidate_id) throw new Error("MERGE_SUPERSEDE refused: the merge already belongs to the bound candidate.")
      if (body.superseded_candidate_id !== stale.candidate_id || body.bound_candidate_id !== binding.candidate_id ||
          body.merge_commit_sha !== stale.merge_commit_sha) {
        throw new Error("MERGE_SUPERSEDE target does not match the current merge pointer and binding.")
      }
      const bound = state.candidates[binding.candidate_id]
      if (!bound || bound.wu_id !== state.wu?.wu_id) throw new Error("MERGE_SUPERSEDE refused: bound candidate is not in the active WU.")
      const priorWu = state.candidates[stale.candidate_id]?.wu_id
      if (!priorWu || priorWu === state.wu.wu_id || state.completed_wus?.[priorWu]?.candidate_id !== stale.candidate_id) {
        throw new Error("MERGE_SUPERSEDE refused: the existing merge is not a settled merge of a completed predecessor WU.")
      }
      state.merge_history ??= []
      state.merge_history.push({
        ...stale,
        status: "SUPERSEDED",
        superseded_at_revision: state.revision,
        superseded_by_candidate_id: binding.candidate_id,
        superseded_by_wu_id: state.wu.wu_id,
      })
      state.merge = null
      break
    }

    case "MERGE_ABORT": {
      if (state.merge?.status !== "STARTED" || body.candidate_id !== state.merge.candidate_id ||
          body.observed_state !== "closed" || body.observed_merged !== false || !body.evidence_ref) throw new Error("MERGE_ABORT requires a confirmed closed, unmerged PR for the exact attempt")
      state.merge_history ??= []
      const aborted = { ...state.merge, status: "ABORTED", evidence_ref: body.evidence_ref }
      state.merge_history.push(aborted)
      state.merges[state.merge.candidate_id] = aborted
      state.merge = null
      break
    }

    case "MERGE_START": {
      const gate = canStartMerge(state, { historicalReplay })
      if (!gate.allowed) throw new Error(`MERGE_START blocked: ${gate.reason}.`)
      if (state.merge) throw new Error("MERGE_START: a merge is already in progress.")
      const binding = state.pr_binding
      state.merge = {
        status: "STARTED",
        attempt_id: body.attempt_id ?? null,
        source: "GOVERNED_AUTO",
        candidate_id: binding.candidate_id,
        repository: binding.repository,
        pr_number: binding.pr_number,
        expected_head_sha: binding.head_sha,
        expected_base_sha: binding.base_sha,
        started_at_revision: state.revision,
        merge_commit_sha: null,
        merged_head_sha: null,
        observed_base_sha: null,
        verified_at_revision: null,
      }
      break
    }

    case "MERGE_EXTERNAL_RECORD": {
      const mergePolicy = state.mandate?.merge_policy ?? "none"
      if (mergePolicy !== "human") throw new Error(`MERGE_EXTERNAL_RECORD requires merge_policy human, got ${mergePolicy}.`)
      if (state.merge) throw new Error("MERGE_EXTERNAL_RECORD: a merge is already recorded.")
      const binding = state.pr_binding
      if (!binding) throw new Error("MERGE_EXTERNAL_RECORD: no PR binding.")
      if (!body.merge_commit_sha) throw new Error("MERGE_EXTERNAL_RECORD requires merge_commit_sha.")
      // Records an already-performed external (human) merge. Never sets STARTED and
      // never authorizes the Harness to execute a merge.
      state.merge = {
        status: "RECORDED",
        source: "HUMAN_EXTERNAL",
        candidate_id: binding.candidate_id,
        repository: binding.repository,
        pr_number: binding.pr_number,
        expected_head_sha: binding.head_sha,
        expected_base_sha: binding.base_sha,
        started_at_revision: state.revision,
        merge_commit_sha: body.merge_commit_sha,
        merged_head_sha: body.merged_head_sha ?? binding.head_sha,
        observed_base_sha: body.observed_base_sha ?? null,
        verified_at_revision: null,
      }
      break
    }

    case "MERGE_RECORD": {
      if (!state.merge || state.merge.status !== "STARTED") throw new Error("MERGE_RECORD requires MERGE_START first.")
      if (!body.merge_commit_sha) throw new Error("MERGE_RECORD requires merge_commit_sha.")
      state.merge.status = "RECORDED"
      state.merge.merge_commit_sha = body.merge_commit_sha
      state.merge.merged_head_sha = body.merged_head_sha ?? null
      break
    }

    case "MERGE_VERIFY": {
      if (!state.merge || state.merge.status !== "RECORDED") throw new Error("MERGE_VERIFY requires a RECORDED merge first (MERGE_RECORD or MERGE_EXTERNAL_RECORD).")
      if (state.merge.merged_head_sha !== state.merge.expected_head_sha) {
        throw new Error(`MERGE_VERIFY: merged head ${state.merge.merged_head_sha} does not match expected ${state.merge.expected_head_sha}.`)
      }
      state.merge.status = "VERIFIED"
      state.merge.verified_at_revision = state.revision
      break
    }

    case "WU_COMPLETE": {
      assertProcessAcceptance(state, body.candidate_id)
      if (!state.wu) throw new Error("WU_COMPLETE requires an active WU.")
      if (state.wu.completed) throw new Error("WU_COMPLETE: the active WU is already complete.")
      if (state.blocker) {
        if (TERMINAL_BLOCKER_CLASSES.has(state.blocker.class)) {
          throw new Error(`WU_COMPLETE blocked: terminal blocker ${state.blocker.class}; a WU cannot close under a hard stop.`)
        }
        throw new Error(`WU_COMPLETE blocked: unresolved blocker ${state.blocker.class}; clear the recoverable blocker before closure.`)
      }
      const candidateId = body.candidate_id
      if (!candidateId) throw new Error("WU_COMPLETE requires candidate_id.")
      const candidate = state.candidates[candidateId]
      if (candidate?.superseded_by_contract) throw new Error("Candidate contract superseded; refreeze and obtain fresh review")
      if (!candidate) throw new Error(`WU_COMPLETE: unknown candidate ${candidateId}.`)
      if (candidate.wu_id !== state.wu.wu_id) {
        throw new Error(`WU_COMPLETE: candidate ${candidateId} belongs to ${candidate.wu_id}, not the active WU ${state.wu.wu_id}.`)
      }
      const review = state.reviews[candidateId]
      if (!review) throw new Error(`WU_COMPLETE: no review recorded for candidate ${candidateId}.`)
      if (review.verdict !== "PASS") {
        throw new Error(`WU_COMPLETE: review verdict is ${review.verdict}, not PASS.`)
      }
      if (!historicalReplay && (!Array.isArray(review.verification_evidence_ids) || review.verification_evidence_ids.length === 0)) {
        throw new Error("WU_COMPLETE: PASS review lacks verification evidence; reverify and review the candidate.")
      }
      const settled = new Set([DISPATCH_STATUS.RESULT_RECONCILED, DISPATCH_STATUS.ABANDONED_RECONCILED, DISPATCH_STATUS.RELEASED])
      const unsettled = Object.entries(state.dispatches).filter(([, d]) => !settled.has(d.status))
      if (unsettled.length > 0) {
        throw new Error(`WU_COMPLETE: ${unsettled.length} dispatch(es) not settled (must be RESULT_RECONCILED or RELEASED): ${unsettled.map(([id]) => id).join(", ")}.`)
      }
      // Governed merge gate: governed_auto and human require a verified merge bound
      // to the exact candidate being closed. none keeps the V1 completion behavior.
      const mergePolicy = state.mandate?.merge_policy ?? "none"
      if (mergePolicy === "governed_auto") {
        if (state.merge?.status !== "VERIFIED") {
          throw new Error(`WU_COMPLETE: merge policy ${mergePolicy} requires merge.status VERIFIED, got ${state.merge?.status ?? "none"}.`)
        }
        if (state.merge.candidate_id !== candidateId) {
          throw new Error(`WU_COMPLETE: merge candidate ${state.merge.candidate_id} does not match the candidate being closed ${candidateId}.`)
        }
      } else if (mergePolicy === "human") {
        if (state.merge?.status !== "VERIFIED") {
          throw new Error(`WU_COMPLETE: merge policy ${mergePolicy} requires merge.status VERIFIED, got ${state.merge?.status ?? "none"}.`)
        }
        if (state.merge.source !== "HUMAN_EXTERNAL") {
          throw new Error(`WU_COMPLETE: merge policy human requires source HUMAN_EXTERNAL, got ${state.merge?.source ?? "none"}.`)
        }
        if (state.merge.candidate_id !== candidateId) {
          throw new Error(`WU_COMPLETE: merge candidate ${state.merge.candidate_id} does not match the candidate being closed ${candidateId}.`)
        }
      }
      state.wu.completed = true
      state.wu.completion = { candidate_id: candidateId, at_revision: state.revision }
      state.completed_wus ??= {}
      state.completed_wus[state.wu.wu_id] = structuredClone(state.wu.completion)
      break
    }

    case "COMPLETE": {
      // An older event log may already contain COMPLETE from before WU-level
      // completion was enforced. Replay that durable terminal fact verbatim;
      // only a newly committed COMPLETE must satisfy today's strict gates.
      // project() validates event sequence/revisions; the controller separately
      // validates integrity hashes before replay. Never forge WU_COMPLETE.
      if (!historicalReplay && state.wu && !state.wu.completed) {
        throw new Error(`COMPLETE blocked: active WU ${state.wu.wu_id} is not complete.`)
      }
      if (!historicalReplay && Array.isArray(state.mandate?.wu_sequence)) {
        if (state.activated_wu_ids.length !== state.mandate.wu_sequence.length) {
          const remaining = state.mandate.wu_sequence.slice(state.activated_wu_ids.length)
          throw new Error(`COMPLETE blocked: frozen Epic WU sequence is incomplete; remaining WUs: ${remaining.join(", ")}.`)
        }
        const terminalWu = state.mandate.wu_sequence.at(-1)
        if (!state.wu || state.wu.wu_id !== terminalWu || !state.wu.completed) {
          throw new Error(`COMPLETE blocked: terminal frozen WU ${terminalWu} is not durably complete.`)
        }
      }
      state.completed = true
      state.completion = { result: body.result ?? null, at_revision: state.revision }
      break
    }

    default:
      throw new Error(`Unhandled operation type: ${event.operation_type}.`)
  }

  // Derived indexes also rebuild when replaying pre-index event logs. Never
  // rewrite events or discard the active aliases used by older clients.
  state.pr_bindings ??= {}
  state.merges ??= {}
  if (state.pr_binding) state.pr_bindings[state.pr_binding.candidate_id] = structuredClone(state.pr_binding)
  if (state.merge) state.merges[state.merge.candidate_id] = structuredClone(state.merge)

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
