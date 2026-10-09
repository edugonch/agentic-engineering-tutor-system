import { stableHash } from './serialize.js'

export const PROCESS_DEVIATION = 'TDD_ORDER'
export const blockerFingerprint = blocker => stableHash({ class: blocker.class, reason: blocker.reason, at_revision: blocker.at_revision })
export const activeRecovery = state => state.process_recoveries?.[state.wu?.wu_id] ?? null
export const processPending = state => {
  const recovery = activeRecovery(state)
  return recovery && recovery.status !== 'ACCEPTED'
}
export function hasUnsettledIntegration(state) {
  if (state.external_wait) return true
  if (!state.merge) return false
  const priorWu = state.candidates[state.merge.candidate_id]?.wu_id
  return !(state.merge.status === 'VERIFIED' && priorWu !== state.wu?.wu_id && state.completed_wus?.[priorWu]?.candidate_id === state.merge.candidate_id)
}
export function applicableAuthority(state) {
  return {
    authority_resolutions: state.authority_resolutions?.[state.wu?.wu_id] ?? [],
    process_policy: state.process_policy ?? null,
    process_recovery: activeRecovery(state),
  }
}
export function validateProcessObligations(value) {
  if (!Array.isArray(value)) throw new Error('process_obligations must be an array; preserve and normalize legacy content explicitly')
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) continue // legacy prose remains authoritative
    if (!item || Array.isArray(item) || item.kind !== 'tdd' || item.required !== true || Object.keys(item).some(k => !['kind', 'required'].includes(k))) {
      throw new Error('Unknown structured process obligation; supported: {kind:"tdd",required:true}; preserve legacy prose')
    }
  }
}
export const requiresTdd = state => state.wu?.contract?.process_obligations?.some?.(o => o?.kind === 'tdd' && o.required === true) ?? false
export function assertProcessAcceptance(state, candidateId) {
  const recovery = activeRecovery(state)
  if (recovery && (recovery.status !== 'ACCEPTED' || recovery.candidate_id !== candidateId)) throw new Error('PROCESS_RECOVERY_PENDING: independent process acceptance for this exact candidate is required')
  if (requiresTdd(state) && !recovery) {
    const red = state.process_red?.[state.wu.wu_id]
    const candidate = state.candidates[candidateId]
    if (!red || !candidate?.process_recorded_revision || red.at_revision >= candidate.process_recorded_revision || red.candidate_id === candidateId) {
      throw new Error('PROCESS_RED_REQUIRED: observed baseline RED before the final candidate, or authorized retrospective recovery, is required')
    }
  }
}
export function processReviewAttestation(dispatch) {
  if (dispatch?.handoff?.truncated) throw new Error('Complete independent reviewer handoff required; truncated output cannot establish acceptance')
  const lines = String(dispatch?.handoff?.content ?? '').split(/\r?\n/).filter(l => l.startsWith('process_review: '))
  if (lines.length !== 1) throw new Error('Independent reviewer must emit one process_review: JSON line in its handoff')
  const a = JSON.parse(lines[0].slice('process_review: '.length))
  if (a.verdict !== 'PASS' || !a.candidate_id || !a.assessment?.trim() || !Array.isArray(a.evidence_ids) || !a.evidence_ids.length || a.evidence_ids.some(id => typeof id !== 'string')) throw new Error('Reviewer has not accepted the exact process evidence')
  return a
}
export function applyProcessEvent(state, event) {
  const b = event.body ?? {}
  if (state.completed) throw new Error('Execution complete')
  switch (event.operation_type) {
    case 'PROCESS_POLICY_ADOPT': {
      const p = b.policy
      if (!p || p.execution_id + ':exec' !== state.execution_id || p.mandate_id !== state.mandate?.mandate_id || p.scope !== 'remaining_epic' ||
        !Array.isArray(p.recoverable) || p.recoverable.length !== 1 || p.recoverable[0] !== PROCESS_DEVIATION || typeof p.technical_verification !== 'boolean' ||
        !Array.isArray(p.legacy_blocker_hashes) || p.legacy_blocker_hashes.some(h => !/^[a-f0-9]{64}$/.test(h))) throw new Error('Invalid scoped process policy')
      if (state.process_policy) throw new Error('Process policy already adopted; do not replace authority silently')
      if (!b.source_record_key || !/^[a-f0-9]{64}$/.test(b.source_hash ?? '') || !b.decision_content) throw new Error('Approved policy provenance required')
      state.process_policy = { ...b, at_revision: state.revision }
      break
    }
    case 'PROCESS_RECOVERY_START': {
      if (!state.wu || state.wu.completed || b.wu_id !== state.wu.wu_id || b.kind !== PROCESS_DEVIATION || !b.reason?.trim() || !b.evidence_ref?.trim()) throw new Error('Exact active WU deviation evidence required')
      const p = state.process_policy?.policy
      if (!p?.recoverable.includes(b.kind)) throw new Error('Applicable process recovery policy required')
      if (state.budget.active_phase || Object.values(state.dispatches).some(d => !['released', 'result_reconciled'].includes(d.status))) throw new Error('Settle existing work before process recovery')
      if (hasUnsettledIntegration(state)) throw new Error('Observe/settle existing integration before process recovery')
      if ((state.blocker?.at_revision ?? null) !== b.blocked_at_revision) throw new Error('Process recovery blocker changed')
      if (state.blocker) {
        const typed = state.blocker.class === 'BLOCKED_PROCESS' && state.blocker.kind === b.kind
        const legacy = state.blocker.class === 'BLOCKED_AUTHORITY' && p.legacy_blocker_hashes.includes(blockerFingerprint(state.blocker))
        if (!typed && !legacy) throw new Error('Process recovery cannot clear this authority/security/scope blocker')
      }
      if (activeRecovery(state)) throw new Error('Existing recovery must be resumed, not restarted')
      state.process_recoveries ??= {}
      state.process_recoveries[b.wu_id] = { ...b, status: 'REPAIRING', evidence: [], at_revision: state.revision,
        original_blocker: state.blocker, policy_source_hash: state.process_policy.source_hash,
        deviation: 'Implementation preceded required RED. No historical RED is claimed. Retrospective validation follows the approved recovery policy.' }
      if (state.blocker) state.last_blocker_resolution = { ...state.blocker, blocked_at_revision: state.blocker.at_revision, resolution: 'Moved to process repair; acceptance remains pending', at_revision: state.revision }
      state.blocker = null
      break
    }
    case 'PROCESS_EVIDENCE': {
      const r = activeRecovery(state)
      if (!r || state.wu?.completed || hasUnsettledIntegration(state) || b.wu_id !== state.wu.wu_id || !['baseline', 'mutation'].includes(b.method) || !b.invariant?.trim() || !b.receipt?.evidence_id) throw new Error('Active recovery and invariant evidence required')
      if (r.status === 'ACCEPTED') r.status = 'REPAIRING'
      if (r.evidence.some(e => e.receipt.evidence_id === b.receipt.evidence_id)) throw new Error('Duplicate process evidence')
      r.evidence.push({ ...b, at_revision: state.revision })
      break
    }
    case 'PROCESS_RED_RECORD': {
      if (!state.wu || state.wu.completed || b.wu_id !== state.wu.wu_id || !b.receipt?.evidence_id) throw new Error('Active WU and observed RED required')
      if (Object.values(state.candidates).some(c => c.wu_id === b.wu_id)) throw new Error('Candidate already recorded; use retrospective recovery instead of reconstructing RED')
      state.process_red ??= {}
      if (state.process_red[b.wu_id]) throw new Error('RED already recorded')
      state.process_red[b.wu_id] = { ...b, at_revision: state.revision, claim: 'Observed failure before final candidate registration; not proof of unobserved editing history' }
      break
    }
    case 'PROCESS_REVIEW': {
      const r = activeRecovery(state), d = state.dispatches[b.review_dispatch_id], candidate = state.candidates[b.candidate_id]
      if (!r || state.wu?.completed || hasUnsettledIntegration(state) || !candidate || candidate.wu_id !== state.wu.wu_id || candidate.superseded_by_contract || !r.evidence.length || !b.assessment?.trim()) throw new Error('Process review requires current candidate and retrospective evidence')
      if (r.status === 'ACCEPTED' && r.candidate_id === b.candidate_id) throw new Error('Process review already accepted')
      if (!d || d.wu_id !== state.wu.wu_id || d.expected_agent !== 'harness-reviewer' || d.status !== 'result_reconciled' || !d.handoff?.content_hash || !d.session_id || d.session_id === d.prepared_by_session_id) throw new Error('Independent reconciled reviewer handoff required')
      if (d.process_review_candidate_id !== b.candidate_id || d.process_evidence_hash !== stableHash(r.evidence)) throw new Error('Reviewer was not dispatched for this candidate and evidence set')
      const attestation = processReviewAttestation(d)
      if (attestation.candidate_id !== b.candidate_id || attestation.assessment !== b.assessment || stableHash(attestation.evidence_ids) !== stableHash(b.evidence_ids)) throw new Error('Process verdict must come from the independent handoff')
      if (b.handoff_hash !== d.handoff.content_hash) throw new Error('Reviewer handoff mismatch')
      const negatives = r.evidence.map(e => e.receipt.evidence_id).sort()
      if (stableHash([...(b.evidence_ids ?? [])].sort()) !== stableHash(negatives)) throw new Error('Review must evaluate every recorded process evidence item')
      if (r.evidence.some(e => e.candidate_id === b.candidate_id)) throw new Error('Negative evidence must use a different baseline/mutation candidate')
      r.review_history ??= []; if (r.review) r.review_history.push(r.review)
      r.status = 'ACCEPTED'; r.candidate_id = b.candidate_id; r.review = { ...b, at_revision: state.revision }
      break
    }
  }
}
