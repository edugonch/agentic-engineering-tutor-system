// Phase 4 extensions to the existing event projection. No independent state store:
// every counter, authorization, lineage edge and stop is rebuilt from events.
import { stableHash, stableSerialize } from './serialize.js'
import { assertCandidatePath, composeCandidateEntries } from './candidate.js'
import { TERMINAL_BLOCKER_CLASSES } from './constants.js'

const RECOVERABLE = new Set(['BLOCKED_TOOLING', 'BLOCKED_EXTERNAL_FACT', 'BLOCKED_ARCHITECTURE', 'BASELINE_REMEDIATION_REQUIRED'])
const AUDIT = new Set(['CHECKPOINT', 'DISPATCH_FINISH', 'DISPATCH_RECONCILE', 'DISPATCH_RELEASE', 'DISPATCH_MARK_AMBIGUOUS'])
const settled = (d) => ['result_reconciled', 'released'].includes(d.status)
const complete = (d) => d?.status === 'result_reconciled'
const available = (s) => s.budget.total_seconds - s.budget.used_seconds - s.budget.reserved_seconds
const requireThat = (condition, message) => { if (!condition) throw new Error(message) }
const text = (v) => typeof v === 'string' && v.trim().length > 0
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)

const CONVERGENCE_BUDGET_MAX = 8

export function validateRepairPolicy(p) {
  requireThat(p && p.version === 1, 'Unsupported repair policy version.')
  requireThat(Number.isSafeInteger(p.max_repair_cycles) && p.max_repair_cycles >= 0 && p.max_repair_cycles <= CONVERGENCE_BUDGET_MAX, `max_repair_cycles must be an integer between 0 and ${CONVERGENCE_BUDGET_MAX}.`)
  const convergenceBudget = p.repair_convergence_budget ?? p.max_repair_cycles
  requireThat(Number.isSafeInteger(convergenceBudget) && convergenceBudget >= p.max_repair_cycles && convergenceBudget <= CONVERGENCE_BUDGET_MAX, 'repair_convergence_budget must be >= max_repair_cycles and <= ' + CONVERGENCE_BUDGET_MAX + '.')
  requireThat(text(p.wu_id) && hash(p.wu_contract_hash) && hash(p.verification_contract_hash), 'Repair policy requires exact WU and contract hashes.')
  if (p.wu_ids !== undefined) {
    requireThat(Array.isArray(p.wu_ids) && p.wu_ids.length > 0 && p.wu_ids.every(text), 'wu_ids must be a non-empty array of WU identifiers.')
    requireThat(new Set(p.wu_ids).size === p.wu_ids.length, 'wu_ids contains duplicates.')
  }
  assertCandidatePath(p.wu_contract_path)
  requireThat(Array.isArray(p.allowed_paths) && p.allowed_paths.length > 0, 'Repair policy requires allowed_paths.')
  p.allowed_paths.forEach(assertCandidatePath)
  requireThat(new Set(p.allowed_paths).size === p.allowed_paths.length, 'Duplicate allowed path.')
  if (p.base_files !== undefined) {
    requireThat(Array.isArray(p.base_files), 'base_files must be an approved identity list.')
    const paths = new Set()
    for (const entry of p.base_files) {
      assertCandidatePath(entry.path)
      requireThat(!paths.has(entry.path) && entry.type === 'file' && hash(entry.sha256) && ['100644', '100755'].includes(entry.mode), 'Invalid or duplicate approved base file identity.')
      paths.add(entry.path)
    }
  }
  for (const field of ['build_seconds', 'repair_seconds', 'review_seconds']) {
    requireThat(Number.isFinite(p[field]) && p[field] > 0, `Repair policy requires positive ${field}.`)
  }
  requireThat(Array.isArray(p.recovery_actions), 'Repair policy requires explicit recovery_actions (may be empty).')
  const ids = new Set()
  for (const a of p.recovery_actions) {
    requireThat(text(a.id) && !ids.has(a.id), 'Recovery action needs a unique id.')
    ids.add(a.id)
    requireThat(RECOVERABLE.has(a.class), 'Terminal blocker cannot have a recovery action.')
    requireThat(['harness-builder', 'harness-researcher', 'orchestrator'].includes(a.actor), 'Unknown recovery actor.')
    requireThat(text(a.tool) && a.input && typeof a.input === 'object' && !Array.isArray(a.input), 'Recovery needs an exact tool/input descriptor.')
    requireThat(Number.isFinite(a.reserved_seconds) && a.reserved_seconds > 0 && text(a.success_check_id), 'Recovery requires reservation and declared success check.')
    if (a.class === 'BLOCKED_EXTERNAL_FACT') requireThat(a.actor === 'harness-researcher' && text(a.question), 'Research requires one exact question and harness-researcher.')
    if (a.class === 'BLOCKED_ARCHITECTURE') requireThat(text(a.decision_ref), 'Architecture recovery requires an already approved decision reference.')
  }
  return { ...structuredClone(p), repair_convergence_budget: convergenceBudget }
}

function stop(s, cls, reason, event, { evidence = null, failure_signature = null } = {}) {
  const b = { blocker_id: `stop:${event.operation_id}`, class: cls, reason, at_revision: event.next_revision, failure_signature: failure_signature ?? stableHash({ cls, reason }), evidence }
  s.blocker = b
  s.blocker_history.push(structuredClone(b))
}

function active(s) {
  requireThat(s.wu && !s.wu.completed && !s.completed, 'An active incomplete WU is required.')
}

function evidence(s, body, dispatch, candidate, { pass = false, check } = {}) {
  const ids = body.verification_evidence_ids ?? []
  const receipts = body.evidence_receipts ?? []
  requireThat(ids.length > 0 && new Set(ids).size === ids.length && receipts.length === ids.length, 'Fresh verification evidence is required.')
  requireThat(new Set(receipts.map(r => r.check_id)).size === receipts.length, 'Duplicate check coverage.')
  for (const [i, r] of receipts.entries()) {
    requireThat(r.evidence_id === ids[i] && r.candidate_id === candidate && r.verification_contract_hash === s.mandate.repair_policy.verification_contract_hash, 'Evidence is bound to a different candidate/contract.')
    requireThat(['PASS', 'FAIL'].includes(r.status) && (!pass || r.status === 'PASS'), 'Evidence must be an executed check with the required verdict.')
    requireThat(Number.isFinite(Date.parse(r.fingerprint?.timestamp)) && Date.parse(r.fingerprint.timestamp) >= Date.parse(dispatch.launched_at), 'Stale evidence predates this dispatch.')
    requireThat(Date.parse(r.fingerprint.timestamp) <= Date.parse(dispatch.finished_at), 'Evidence must be produced within the reserved dispatch.')
  }
  if (check) requireThat(receipts.some(r => r.check_id === check && r.status === 'PASS'), 'Missing successful declared recovery check.')
}

function findingsSignature(findings) {
  // Stable finding identity excludes prose, timestamps, session IDs and temp paths.
  return stableHash(findings.map(f => ({ id: f.id, location: f.location })).sort((a, b) => a.id.localeCompare(b.id)))
}

function findingsFingerprint(findings) {
  // Human-inspectible convergence evidence: counts by severity plus stable signatures.
  const counts = {}
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1
  }
  return { signature: findingsSignature(findings), count: findings.length, counts, ids: findings.map(f => f.id).sort() }
}

function demonstratesProgress(current, history) {
  if (history.length === 0) return { progress: true }
  const prior = history[history.length - 1]
  const prior2 = history.length >= 2 ? history[history.length - 2] : null

  // Strict reduction in total findings.
  if (current.count < prior.count) return { progress: true, reason: 'finding-count-reduced' }

  // Strict reduction in high-severity findings.
  const high = (s) => ['high', 'major', 'critical', 'security'].includes(String(s).toLowerCase())
  const currentHigh = Object.entries(current.counts).filter(([sev]) => high(sev)).reduce((sum, [, c]) => sum + c, 0)
  const priorHigh = Object.entries(prior.counts).filter(([sev]) => high(sev)).reduce((sum, [, c]) => sum + c, 0)
  if (currentHigh < priorHigh) return { progress: true, reason: 'high-severity-reduced' }

  // Repeated identical signature compared to immediate prior cycle is not progress.
  if (current.signature === prior.signature) {
    return { progress: false, reason: 'REPEATED_IDENTICAL_FAILURE', evidence: { current, prior } }
  }

  // Oscillation between cycles (same signature as two cycles ago) is not progress.
  if (prior2 && current.signature === prior2.signature) {
    return { progress: false, reason: 'OSCILLATING_FINDINGS', evidence: { current, prior, prior2 } }
  }

  // Beyond the hard max_repair_cycles, require strict reduction; semantic
  // churn without reduction is non-convergence.
  return { progress: false, reason: 'NON_CONVERGING_REWORK', evidence: { current, prior } }
}

function changedPaths(oldManifest, newManifest) {
  const entries = (m) => composeCandidateEntries(m?.base?.files ?? [], m?.deletions ?? [], m?.overlay ?? [])
  const a = new Map(entries(oldManifest).map(e => [e.path, stableSerialize(e)]))
  const b = new Map(entries(newManifest).map(e => [e.path, stableSerialize(e)]))
  return [...new Set([...a.keys(), ...b.keys()])].filter(p => a.get(p) !== b.get(p))
}

// Returns true only for the three new events; existing events retain their
// original applyEvent implementation and receive additional guards/metadata.
export function beforeRepairEvent(s, e) {
  const b = e.body ?? {}
  const type = e.operation_type
  const p = s.mandate?.repair_policy
  if (type === 'MANDATE_APPROVE' && b.repair_policy) {
    requireThat(!s.mandate, 'An execution mandate cannot be replaced.')
    requireThat(b.authority_kind === 'OWNER_APPROVED_EPIC' && Number.isSafeInteger(b.max_wus) && b.max_wus >= 1, 'Phase 4 requires a positive WU count under an approved Epic.')
    validateRepairPolicy(b.repair_policy)
  }
  if (!p) {
    requireThat(!['REPAIR_AUTHORIZE', 'BLOCKER_RECOVERY_AUTHORIZE', 'BLOCKER_RESOLVE'].includes(type), 'No repair/recovery authority in this mandate.')
    return false
  }
  requireThat(type !== 'MANDATE_APPROVE', 'An execution mandate cannot be replaced or topped up.')
  if (s.blocker && TERMINAL_BLOCKER_CLASSES.has(s.blocker.class) && !AUDIT.has(type)) {
    throw new Error(`Forward execution blocked by terminal ${s.blocker.class}.`)
  }
  if (s.completed || s.wu?.completed) requireThat(AUDIT.has(type) || type === 'EPIC_CONTINUE' || type === 'COMPLETE', 'Execution/WU is already complete.')
  if (type === 'WU_ACTIVATE') {
    const allowedWuIds = p.wu_ids ?? [p.wu_id]
    requireThat(allowedWuIds.includes(b.wu_id), 'WU outside the approved repair policy scope.')
    return false
  }
  if (type === 'CHECKPOINT') {
    if (b.launch_claim) {
      const d = s.dispatches[b.launch_claim.dispatch_id]
      requireThat(!s.blocker || !TERMINAL_BLOCKER_CLASSES.has(s.blocker.class), 'Terminal blocker forbids launch claims.')
      requireThat(!s.blocker || s.recoveries[s.blocker.blocker_id]?.dispatch_id === b.launch_claim.dispatch_id, 'Blocker forbids this launch claim.')
      requireThat(d?.status === 'pending_launch' && !d.launch_call_id && text(b.launch_claim.call_id), 'Launch dispatch already claimed or not pending.')
    }
    if (b.recovery_action_claim) {
      const claim = b.recovery_action_claim
      const rec = s.recoveries[s.blocker?.blocker_id]
      const d = s.dispatches[rec?.dispatch_id]
      requireThat(s.blocker && RECOVERABLE.has(s.blocker.class) && d?.status === 'launched' && d.session_id === claim.session_id, 'Recovery action claim requires its live authorized dispatch.')
      requireThat(!rec.action_claim && !rec.action_evidence, 'Recovery action attempt already claimed/consumed.')
      requireThat(text(claim.tool_call_id) && claim.action_hash === stableHash(rec.action), 'Recovery claim must bind the exact action and tool call.')
    }
    if (b.recovery_action_evidence) {
      const rec = s.recoveries[s.blocker?.blocker_id]
      const d = s.dispatches[rec?.dispatch_id]
      requireThat(d?.status === 'launched' && d.session_id === b.recovery_action_evidence.session_id && !rec.action_evidence, 'Recovery action evidence requires its live dispatch and cannot be repeated.')
      requireThat(b.recovery_action_evidence.action_hash === stableHash(rec.action) && hash(b.recovery_action_evidence.result_hash), 'Recovery action evidence does not match approved action.')
      requireThat(rec.action_claim?.tool_call_id === b.recovery_action_evidence.tool_call_id && ['PASS', 'FAIL'].includes(b.recovery_action_evidence.status), 'Recovery evidence requires its claimed tool call and explicit outcome.')
    }
    return false
  }
  if (type === 'DISPATCH_RELEASE') requireThat(!s.dispatches[b.dispatch_id]?.launch_call_id, 'Claimed launch is ambiguous; its reservation cannot be released.')
  if (type === 'BLOCK' && s.blocker) requireThat(TERMINAL_BLOCKER_CLASSES.has(b.class), 'Cannot replace an unresolved blocker with another recoverable blocker.')
  if (type === 'EPIC_CONTINUE') {
    requireThat(s.epic, 'EPIC_CONTINUE requires an Epic queue.')
    requireThat(!s.wu || s.wu.completed, 'EPIC_CONTINUE requires no active incomplete WU.')
    return false
  }
  if (type === 'COMPLETE') {
    requireThat(s.wu?.completed || !s.wu, 'COMPLETE requires the active WU to be complete or absent.')
    return false
  }
  if (type === 'BLOCK' || AUDIT.has(type)) return false
  active(s)
  if (s.blocker && !['BLOCKER_RECOVERY_AUTHORIZE', 'BLOCKER_RESOLVE'].includes(type)) {
    const recovery = s.recoveries[s.blocker.blocker_id]
    requireThat(['DISPATCH_RESERVE', 'DISPATCH_PREPARE', 'DISPATCH_LAUNCH'].includes(type) && recovery?.dispatch_id === b.dispatch_id, 'Unresolved blocker suspends ordinary work.')
  }
  if (type === 'REPAIR_AUTHORIZE') {
    const id = s.wu.current_candidate_id
    const r = s.reviews[id]
    requireThat(b.candidate_id === id && r?.verdict === 'CHANGES_REQUIRED', 'Repair requires the current candidate CHANGES_REQUIRED review.')
    requireThat(!s.repair || s.repair.candidate_b, 'Repair already authorized; resume the same dispatch.')
    const budget = p.repair_convergence_budget ?? p.max_repair_cycles
    if (s.wu.repair_cycle_count >= budget) {
      // Within convergence budget we already require strict progress; exceeding
      // the budget is a terminal non-convergence stop. Preserve the legacy
      // REPAIR_LIMIT_REACHED reason when no extra convergence budget was granted.
      const reason = budget === p.max_repair_cycles ? 'REPAIR_LIMIT_REACHED' : 'NON_CONVERGING_REWORK'
      stop(s, 'NO_PROGRESS', reason, e, { evidence: { reason: 'convergence budget exhausted', repair_cycle_count: s.wu.repair_cycle_count, budget } })
      return true
    }
    requireThat(Object.values(s.dispatches).every(settled), 'Previous work must be settled before repair.')
    requireThat(text(b.dispatch_id) && !s.dispatches[b.dispatch_id], 'Repair dispatch must be unique.')
    requireThat(text(b.hypothesis) && Array.isArray(b.progress_evidence_ids) && b.progress_evidence_ids.length > 0 && b.progress_evidence_ids.every(id => r.findings.some(f => f.id === id)), 'Repair hypothesis must cite recorded findings.')
    if (available(s) < p.repair_seconds + p.review_seconds) { stop(s, 'BUDGET_EXHAUSTED', 'Repair and fresh review cannot be funded.', e); return true }

    // Convergence detection: beyond the legacy max_repair_cycles, repairs must
    // demonstrate strict progress or they stop with evidence.
    if (s.wu.repair_cycle_count >= p.max_repair_cycles) {
      const history = (s.repair_history ?? []).map(h => findingsFingerprint(h.findings ?? []))
      const current = findingsFingerprint(r.findings ?? [])
      const assessment = demonstratesProgress(current, history)
      if (!assessment.progress) {
        stop(s, 'NO_PROGRESS', assessment.reason, e, { evidence: assessment.evidence, failure_signature: stableHash({ reason: assessment.reason, current, history }) })
        return true
      }
    }

    s.wu.repair_cycle_count++
    s.repair = { authorization_id: e.operation_id, review_id: r.review_id, findings: structuredClone(r.findings), findings_hash: r.findings_hash, candidate_a: id, candidate_b: null, dispatch_id: b.dispatch_id, hypothesis: b.hypothesis, progress_evidence_ids: b.progress_evidence_ids, wu_id: s.wu.wu_id, mandate_id: s.mandate.mandate_id, contract_hash: p.wu_contract_hash }
    s.repair_history.push(structuredClone(s.repair))
    return true
  }
  if (type === 'BLOCKER_RECOVERY_AUTHORIZE') {
    requireThat(s.blocker && s.blocker.blocker_id === b.blocker_id && RECOVERABLE.has(s.blocker.class), 'Recoverable active blocker required.')
    requireThat(!s.recoveries[b.blocker_id], 'Recovery already authorized; resume the same attempt/dispatch.')
    const action = p.recovery_actions.find(a => a.id === b.recovery_action_id && a.class === s.blocker.class)
    requireThat(action, 'No approved recovery action for this blocker.')
    if ((s.wu.recovery_attempts[s.blocker.class] ?? 0) >= 1) { stop(s, 'NO_PROGRESS', 'RECOVERY_LIMIT_REACHED', e); return true }
    requireThat(text(b.hypothesis) && b.progress_evidence_ids?.includes(b.blocker_id), 'Recovery hypothesis must cite the blocker evidence.')
    requireThat(text(b.dispatch_id) && !s.dispatches[b.dispatch_id] && Object.values(s.dispatches).every(settled), 'Recovery requires unique dispatch and settled prior work.')
    if (available(s) < action.reserved_seconds) { stop(s, 'BUDGET_EXHAUSTED', 'Recovery cannot be funded.', e); return true }
    s.wu.recovery_attempts[s.blocker.class] = 1
    s.recoveries[b.blocker_id] = { authorization_id: e.operation_id, dispatch_id: b.dispatch_id, action: structuredClone(action), hypothesis: b.hypothesis, progress_evidence_ids: b.progress_evidence_ids, candidate_id: s.wu.current_candidate_id, resolved: false }
    return true
  }
  if (type === 'BLOCKER_RESOLVE') {
    requireThat(s.blocker?.blocker_id === b.blocker_id, 'Active blocker mismatch.')
    const recovery = s.recoveries[b.blocker_id]
    const d = s.dispatches[recovery?.dispatch_id]
    requireThat(recovery && !recovery.resolved && complete(d), 'Recovery requires its settled authorized dispatch.')
    requireThat(recovery.action_evidence?.status === 'PASS', 'Recovery requires successful observed action evidence, not just a caller success claim.')
    evidence(s, b, d, recovery.candidate_id, { pass: true, check: recovery.action.success_check_id })
    recovery.resolved = true
    recovery.verification_evidence_ids = b.verification_evidence_ids
    recovery.resolved_at_revision = e.next_revision
    s.blocker_history.find(x => x.blocker_id === b.blocker_id).resolution = structuredClone(recovery)
    s.blocker = null
    return true
  }
  if (type === 'DISPATCH_RESERVE') {
    requireThat(b.reserved_seconds > 0 && Number.isFinite(b.reserved_seconds), 'Governed dispatch needs a positive finite reservation.')
    const purpose = b.purpose
    requireThat(['BUILD', 'REPAIR', 'REVIEW', 'RECOVERY'].includes(purpose), 'Governed dispatch requires a typed purpose.')
    let required
    let slot
    if (purpose === 'BUILD') {
      requireThat(!s.wu.current_candidate_id && !s.repair, 'BUILD cannot bypass repair.')
      required = p.build_seconds; slot = 'BUILD'
    } else if (purpose === 'REPAIR') {
      requireThat(s.repair?.dispatch_id === b.dispatch_id && !s.repair.candidate_b && b.candidate_id === s.repair.candidate_a, 'Dispatch not bound to active repair.')
      required = p.repair_seconds; slot = `REPAIR:${s.repair.authorization_id}`
    } else if (purpose === 'REVIEW') {
      requireThat(b.candidate_id === s.wu.current_candidate_id && !s.reviews[b.candidate_id], 'REVIEW requires current unreviewed candidate.')
      required = p.review_seconds; slot = `REVIEW:${b.candidate_id}`
    } else {
      const rec = s.recoveries[s.blocker?.blocker_id]
      requireThat(rec?.dispatch_id === b.dispatch_id && !rec.resolved, 'Dispatch not bound to recovery.')
      required = rec.action.reserved_seconds; slot = `RECOVERY:${rec.authorization_id}`
    }
    requireThat(b.reserved_seconds === required, 'Reservation must match approved execution envelope.')
    requireThat(!Object.values(s.dispatches).some(d => d.slot === slot), 'Duplicate semantic dispatch slot.')
    const remainingReview = ['BUILD', 'REPAIR'].includes(purpose) ? p.review_seconds : 0
    if (available(s) < required + remainingReview) { stop(s, 'BUDGET_EXHAUSTED', 'Dispatch and required review cannot be funded.', e); return true }
    return false
  }
  if (type === 'DISPATCH_LAUNCH') {
    const d = s.dispatches[b.dispatch_id]
    requireThat(d?.status === 'pending_launch', 'Prepare before launching a governed dispatch.')
    requireThat(text(b.session_id) && b.session_id !== s.mandate.controller_session_id, 'External actor session required.')
    requireThat(!Object.values(s.dispatches).some(other => other.session_id === b.session_id), 'A fresh independent session is required; session already dispatched.')
  }
  if (type === 'FREEZE_CANDIDATE') {
    const allowedWuIds = p.wu_ids ?? [p.wu_id]
    requireThat(b.wu_id === s.wu.wu_id && allowedWuIds.includes(b.manifest?.verification_contract?.source_wu_id) && b.manifest?.verification_contract?.source_wu_hash === p.wu_contract_hash, 'Candidate WU contract provenance mismatch.')
    requireThat(b.verification_contract_hash === p.verification_contract_hash, 'Candidate verification contract changed.')
    requireThat(b.required_check_ids?.length > 0, 'Candidate needs declared checks.')
    const d = s.dispatches[b.dispatch_id]
    requireThat(complete(d), 'Candidate requires settled build/repair handoff.')
    const previous = s.candidates[s.wu.current_candidate_id]
    if (previous) {
      requireThat(s.repair?.dispatch_id === b.dispatch_id && !s.repair.candidate_b && d.purpose === 'REPAIR', 'Candidate replacement requires authorized repair.')
      requireThat(b.tree_hash !== previous.tree_hash && b.candidate_id !== s.wu.current_candidate_id, 'Unchanged candidate/tree is not repair progress.')
    } else requireThat(d.purpose === 'BUILD', 'Initial candidate needs a BUILD dispatch.')
    // Initial base is frozen separately from the change overlay. Successors must
    // preserve all out-of-scope material in the composed tree, not just overlay.
    const paths = changedPaths(previous?.manifest ?? { overlay: p.base_files ?? [] }, b.manifest)
    requireThat(paths.every(path => p.allowed_paths.includes(path)), 'Candidate changes exceed approved scope.')
  }
  if (type === 'RECORD_REVIEW') {
    requireThat(!s.reviews[b.candidate_id], 'Candidate review is immutable; already reviewed.')
    requireThat(b.candidate_id === s.wu.current_candidate_id, 'Review must bind current candidate.')
    requireThat(['PASS', 'CHANGES_REQUIRED', 'BLOCKED'].includes(b.verdict), 'Unknown review verdict.')
    const d = s.dispatches[b.dispatch_id]
    requireThat(complete(d) && d.purpose === 'REVIEW' && d.candidate_id === b.candidate_id && b.reviewer === d.session_id, 'Review requires its independent settled reviewer dispatch.')
    requireThat(Array.isArray(b.findings), 'Review must preserve findings.')
    if (b.verdict !== 'PASS') requireThat(b.findings.length > 0, 'Non-PASS review needs actionable findings.')
    if (b.verdict === 'PASS') requireThat(b.findings.length === 0, 'PASS cannot discard unresolved findings.')
    requireThat(new Set(b.findings.map(f => f.id)).size === b.findings.length && b.findings.every(f => ['id', 'severity', 'location', 'evidence', 'impact', 'correction'].every(k => text(f[k]))), 'Findings must have unique IDs and complete evidence.')
    evidence(s, b, d, b.candidate_id, { pass: b.verdict === 'PASS' })
  }
  if (type === 'WU_COMPLETE') {
    requireThat(b.candidate_id === s.wu.current_candidate_id && !s.candidates[b.candidate_id]?.superseded_by, 'Only current unsuperseded candidate can complete WU.')
    requireThat(!s.repair || s.repair.candidate_b === b.candidate_id, 'Repair is incomplete.')
  }
  if (type === 'CI_CLASSIFY') {
    requireThat(b.candidate_id && s.candidates[b.candidate_id], 'CI_CLASSIFY requires a recorded candidate.')
    requireThat(Array.isArray(b.failing_files), 'CI_CLASSIFY requires failing_files.')
    const hasCandidateCaused = b.failing_files.some(f => f.classification === 'CANDIDATE_CHANGED')
    const hasBaseline = b.failing_files.some(f => f.classification === 'BASELINE_UNCHANGED')
    const hasEnvironment = b.failing_files.some(f => f.classification === 'ENVIRONMENT')
    const hasExternal = b.failing_files.some(f => f.classification === 'EXTERNAL')
    // Baseline-only failures create a recoverable blocker; candidate-caused
    // failures remain in-band for normal repair. Environment/external are
    // handled as their own blocker classes if no candidate-caused issue exists.
    if (!hasCandidateCaused && hasBaseline) {
      stop(s, 'BASELINE_REMEDIATION_REQUIRED', 'CI failure is confined to unchanged baseline files.', e, {
        evidence: { candidate_id: b.candidate_id, check_id: b.check_id, failing_files: b.failing_files },
        failure_signature: stableHash({ candidate_id: b.candidate_id, check_id: b.check_id, baseline_files: b.failing_files.filter(f => f.classification === 'BASELINE_UNCHANGED').map(f => f.path).sort() }),
      })
      return true
    }
    if (!hasCandidateCaused && hasExternal) {
      stop(s, 'EXTERNAL_BLOCKED', 'CI failure is attributed to an external dependency.', e, { evidence: { candidate_id: b.candidate_id, check_id: b.check_id, failing_files: b.failing_files } })
      return true
    }
    if (!hasCandidateCaused && hasEnvironment) {
      stop(s, 'BLOCKED_TOOLING', 'CI failure is attributed to environment/infrastructure.', e, { evidence: { candidate_id: b.candidate_id, check_id: b.check_id, failing_files: b.failing_files } })
      return true
    }
    return false
  }
  if (type === 'BASELINE_REMEDIATE') {
    requireThat(s.blocker?.class === 'BASELINE_REMEDIATION_REQUIRED', 'BASELINE_REMEDIATE requires an active baseline remediation blocker.')
    requireThat(text(b.remediation_wu_id), 'Baseline remediation requires a remediation WU id.')
    requireThat(Array.isArray(b.allowed_paths) && b.allowed_paths.length > 0, 'Baseline remediation requires allowed_paths.')
    return false
  }
  if (type === 'OWNER_DECISION_REQUEST') {
    requireThat(text(b.blocker_id), 'OWNER_DECISION_REQUEST requires a stable blocker_id.')
    requireThat(text(b.reason), 'OWNER_DECISION_REQUEST requires a reason.')
    return false
  }
  if (type === 'PHASE_START') throw new Error('Phase 4 bills through reserved dispatches only.')
  return false
}

export function afterRepairEvent(s, e) {
  const b = e.body ?? {}
  if (e.operation_type === 'MANDATE_APPROVE' && b.repair_policy) {
    s.mandate.repair_policy = validateRepairPolicy(b.repair_policy)
    s.mandate.controller_session_id = b.controller_session_id
    s.blocker_history = []
    s.repair_history = []
    s.repair = null
    s.recoveries = {}
  }
  if (!s.mandate?.repair_policy) return
  switch (e.operation_type) {
    case 'CHECKPOINT':
      if (b.launch_claim) Object.assign(s.dispatches[b.launch_claim.dispatch_id], { launch_call_id: b.launch_claim.call_id, launch_started_at: e.timestamp })
      if (b.recovery_action_claim) s.recoveries[s.blocker.blocker_id].action_claim = { ...b.recovery_action_claim, checkpoint_id: e.operation_id }
      if (b.recovery_action_evidence) {
        s.recoveries[s.blocker.blocker_id].action_evidence = { ...b.recovery_action_evidence, checkpoint_id: e.operation_id }
        if (b.recovery_action_evidence.status === 'FAIL') stop(s, 'NO_PROGRESS', 'RECOVERY_ACTION_FAILED', e)
      }
      break
    case 'WU_ACTIVATE':
      Object.assign(s.wu, { repair_cycle_count: 0, recovery_attempts: {}, current_candidate_id: null })
      break
    case 'DISPATCH_RESERVE': {
      const d = s.dispatches[b.dispatch_id]
      d.purpose = b.purpose
      d.candidate_id = b.candidate_id ?? null
      d.actor = b.purpose === 'REVIEW' ? 'harness-reviewer' : b.purpose === 'RECOVERY' ? s.recoveries[s.blocker.blocker_id].action.actor : 'harness-builder'
      d.slot = b.purpose === 'BUILD' ? 'BUILD' : b.purpose === 'REPAIR' ? `REPAIR:${s.repair.authorization_id}` : b.purpose === 'REVIEW' ? `REVIEW:${b.candidate_id}` : `RECOVERY:${s.recoveries[s.blocker.blocker_id].authorization_id}`
      break
    }
    case 'DISPATCH_LAUNCH': s.dispatches[b.dispatch_id].launched_at = e.timestamp; break
    case 'DISPATCH_FINISH': s.dispatches[b.dispatch_id].finished_at = e.timestamp; break
    case 'FREEZE_CANDIDATE': {
      const a = s.wu.current_candidate_id
      const current = s.candidates[b.candidate_id]
      current.dispatch_id = b.dispatch_id
      current.recorded_at = e.timestamp
      if (a) {
        s.candidates[a].superseded_by = b.candidate_id
        Object.assign(current, { supersedes: a, reason: 'CHANGES_REQUIRED', source_review_id: s.repair.review_id, repair_authorization_id: s.repair.authorization_id })
        s.repair.candidate_b = b.candidate_id
      }
      s.wu.current_candidate_id = b.candidate_id
      break
    }
    case 'RECORD_REVIEW': {
      const r = s.reviews[b.candidate_id]
      Object.assign(r, { review_id: e.operation_id, dispatch_id: b.dispatch_id, findings: structuredClone(b.findings), findings_hash: stableHash(b.findings), failure_signature: findingsSignature(b.findings) })
      const prior = s.repair && s.reviews[s.repair.candidate_a]
      if (prior && b.verdict === 'CHANGES_REQUIRED' && prior.failure_signature === r.failure_signature) stop(s, 'NO_PROGRESS', 'REPEATED_IDENTICAL_FAILURE', e)
      break
    }
    case 'BLOCK': {
      requireThat(text(b.blocker_id) && text(b.failure_signature), 'BLOCK requires stable blocker_id and failure_signature.')
      requireThat(!s.blocker_history.some(x => x.blocker_id === b.blocker_id), 'Duplicate blocker ID.')
      const repeated = s.blocker_history.some(x => x.class === b.class && x.failure_signature === b.failure_signature)
      Object.assign(s.blocker, { blocker_id: b.blocker_id, failure_signature: b.failure_signature, evidence: b.evidence ?? null, origin_session_id: b.origin_session_id ?? null })
      s.blocker_history.push(structuredClone(s.blocker))
      if (repeated && RECOVERABLE.has(b.class)) stop(s, 'NO_PROGRESS', 'REPEATED_IDENTICAL_FAILURE', e)
      break
    }
  }
}
