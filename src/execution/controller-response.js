// Presentation-only; never changes controller state, receipts, or hashes.
// Compatibility: full remains the default for every action.
import { stableHash } from "./serialize.js"
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]))
const count = object => object && typeof object === "object" ? Object.keys(object).length : 0
export function presentControllerResponse(result, { response_detail = "full", dispatch_id, candidate_id } = {}) {
  if (response_detail === "full") return result
  if (response_detail !== "compact") throw new Error("response_detail must be compact or full.")
  const budget = pick(result.budget, ["total_seconds", "used_seconds", "reserved_seconds", "available_seconds", "exhausted"])
  const compact = {
    ...pick(result, ["action","commit_status","status","execution_id","revision","fencing_token",
      "dispatch_id","candidate_id","found","contract_status","passed"]),
    response_detail: "compact",
    wu_id: result.wu?.wu_id ?? null,
    blocker: result.blocker ? pick(result.blocker, ["class","at_revision"]) : null,
    next_action: typeof result.next_action === "object" ?
      pick(result.next_action, ["kind","action","blocked_at_revision"]) : null,
    budget, budget_summary: budget,
    state_digest: stableHash(result),
    dispatch_count: Array.isArray(result.dispatches) ? result.dispatches.length : 0,
    candidate_count: count(result.candidates),
    review_count: count(result.reviews),
  }
  if (result.mandate) compact.mandate = pick(result.mandate, ["mandate_id","authority_kind"])
  if (result.wu) compact.wu = { ...pick(result.wu, ["wu_id","completed","origin"]),
    contract_hash: result.wu.contract?.contract_hash ?? null }
  if (dispatch_id && Array.isArray(result.dispatches)) {
    compact.dispatches = result.dispatches.filter(d=>d.dispatch_id===dispatch_id)
      .map(d=>pick(d, ["dispatch_id","status","session_id","reservation_status","reserved_seconds","actual_consumption","consumption_basis"]))
  }
  if (candidate_id && result.candidates?.[candidate_id]) {
    compact.candidates = { [candidate_id]: pick(result.candidates[candidate_id], ["wu_id","tree_hash","manifest_hash"]) }
  }
  if (candidate_id && result.reviews?.[candidate_id]) {
    compact.reviews = { [candidate_id]: pick(result.reviews[candidate_id], ["verdict","verification_evidence_ids"]) }
  }
  return compact
}
