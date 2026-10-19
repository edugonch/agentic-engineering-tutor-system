// Presentation-only projection. It never changes controller state, receipts, or hashes.
// Full state remains available with response_detail=full and read-only status/recover.
const FULL_ACTIONS = new Set([
  "status", "recover", "verify", "audit_recovery", "inspect_authority_gap",
  "inspect_next_wu_contract", "inspect_scope_worktree",
])

function count(collection) {
  return collection && typeof collection === "object" ? Object.keys(collection).length : 0
}

export function presentControllerResponse(result, { response_detail = "compact", dispatch_id, candidate_id } = {}) {
  if (response_detail === "full" || FULL_ACTIONS.has(result.action)) return result
  if (response_detail !== "compact") throw new Error("response_detail must be compact or full.")
  const compact = { ...result, response_detail: "compact" }
  if (result.mandate) {
    const { mandate_id, authority_kind, source_artifact_id, merge_policy, required_ci_checks, wu_sequence } = result.mandate
    compact.mandate = { mandate_id, authority_kind, source_artifact_id, merge_policy, required_ci_checks,
      wu_count: wu_sequence?.length ?? null }
  }
  if (result.wu) {
    const { wu_id, completed, origin, execution_authorization, contract } = result.wu
    compact.wu = { wu_id, completed, origin, execution_authorization,
      contract_hash: contract?.contract_hash ?? null,
      verification_contract_hash: contract?.verification_contract_hash ?? null }
  }
  if (Array.isArray(result.dispatches)) {
    compact.dispatch_count = result.dispatches.length
    compact.dispatches = dispatch_id
      ? result.dispatches.filter(dispatch => dispatch.dispatch_id === dispatch_id).map(dispatch => ({
          dispatch_id: dispatch.dispatch_id, status: dispatch.status,
          session_id: dispatch.session_id ?? null,
          reservation_status: dispatch.reservation_status,
          reserved_seconds: dispatch.reserved_seconds,
          actual_consumption: dispatch.actual_consumption,
        }))
      : []
  }
  if (result.candidates) {
    compact.candidate_count = count(result.candidates)
    compact.candidates = candidate_id && result.candidates[candidate_id]
      ? { [candidate_id]: { wu_id: result.candidates[candidate_id].wu_id,
          tree_hash: result.candidates[candidate_id].tree_hash } }
      : {}
  }
  if (result.reviews) {
    compact.review_count = count(result.reviews)
    compact.reviews = candidate_id && result.reviews[candidate_id]
      ? { [candidate_id]: { verdict: result.reviews[candidate_id].verdict,
          assessment: result.reviews[candidate_id].assessment,
          verification_evidence_ids: result.reviews[candidate_id].verification_evidence_ids } }
      : {}
  }
  for (const field of ["authority_resolutions", "wu_budget_amendments", "pr_bindings", "merges", "ci_evidence"]) {
    if (result[field] !== undefined) {
      compact[`${field}_count`] = count(result[field])
      delete compact[field]
    }
  }
  delete compact.checkpoint
  return compact
}
