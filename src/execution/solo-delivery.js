// SOLO_CI: the owner explicitly classifies low-risk existing WU IDs once per
// approved Epic. Successful live CI for the frozen PR head can replace the
// redundant local runner/reviewer process ONLY for that preapproved WU.
// No fake REVIEW PASS is created. High-risk/unlisted WUs retain prior gates.
const ID = /^[A-Za-z0-9._:-]{1,181}$/
const SHA = /^[a-f0-9]{64}$/
const HEAD = /^[a-f0-9]{40}$/

export function validSoloPolicy(p) {
  return !!p && !Array.isArray(p) && typeof p === "object" &&
    Object.keys(p).sort().join(",") === "ci_check,eligible_wu_ids,execution_id,mandate_id,mode" &&
    p.mode === "SOLO_CI" && ID.test(p.execution_id ?? "") &&
    ID.test(p.mandate_id ?? "") && ID.test(p.ci_check ?? "") &&
    Array.isArray(p.eligible_wu_ids) && p.eligible_wu_ids.length > 0 &&
    p.eligible_wu_ids.length <= 100 &&
    p.eligible_wu_ids.every(id => typeof id === "string" && ID.test(id)) &&
    new Set(p.eligible_wu_ids).size === p.eligible_wu_ids.length
}

export function soloCandidateEligible(state, candidateId) {
  const p = state.solo_delivery?.policy
  const c = state.candidates?.[candidateId]
  return validSoloPolicy(p) && !state.completed && state.wu &&
    !state.wu.completed && !state.wu.batch &&
    state.mandate?.authority_kind === "OWNER_APPROVED_EPIC" &&
    state.mandate.mandate_id === p.mandate_id &&
    state.execution_id === p.execution_id + ":exec" &&
    state.wu.wu_id === c?.wu_id &&
    p.eligible_wu_ids.includes(c.wu_id) && !c.superseded_by_contract
}

export function soloAccepted(state, candidateId) {
  if (!soloCandidateEligible(state, candidateId) ||
      ["CHANGES_REQUIRED", "BLOCKED"].includes(state.reviews?.[candidateId]?.verdict)) return false
  const proof = state.solo_acceptances?.[candidateId]
  const c = state.candidates[candidateId]
  const binding = state.pr_binding
  return !!proof && !!binding && binding.candidate_id === candidateId &&
    HEAD.test(proof.head_sha ?? "") && proof.head_sha === binding.head_sha &&
    proof.candidate_hashes?.tree_hash === c.tree_hash &&
    proof.candidate_hashes?.manifest_hash === c.manifest_hash &&
    proof.source_hash === state.solo_delivery.source_hash &&
    proof.ci_check === state.solo_delivery.policy.ci_check &&
    proof.conclusion === "SUCCESS" && proof.basis === "LIVE_GITHUB_CI"
}

export function acceptedForMerge(state, candidateId, { historicalReplay = false } = {}) {
  const review = state.reviews?.[candidateId]
  if (review?.verdict === "PASS") {
    if (!historicalReplay && (!Array.isArray(review.verification_evidence_ids) ||
        review.verification_evidence_ids.length === 0)) {
      return { allowed: false, reason: "PASS review lacks verification evidence; reverify and review the candidate" }
    }
    return { allowed: true, route: "INDEPENDENT_REVIEW" }
  }
  if (soloAccepted(state, candidateId)) return { allowed: true, route: "SOLO_CI" }
  return { allowed: false, reason: soloCandidateEligible(state, candidateId)
    ? "no PASS review or verified solo CI acceptance" : "no PASS review" }
}

export function assertSoloAcceptanceEvent(state, body) {
  if (!soloCandidateEligible(state, body.candidate_id))
    throw new Error("SOLO_CI: candidate is not in the exact owner-approved low-risk WU list")
  const c = state.candidates[body.candidate_id]
  const p = state.solo_delivery
  if (!state.pr_binding || state.pr_binding.candidate_id !== body.candidate_id ||
      state.pr_binding.head_sha !== body.head_sha || !HEAD.test(body.head_sha ?? "") ||
      body.basis !== "LIVE_GITHUB_CI" || body.conclusion !== "SUCCESS" ||
      body.ci_check !== p.policy.ci_check || body.source_hash !== p.source_hash ||
      body.candidate_hashes?.manifest_hash !== c.manifest_hash ||
      body.candidate_hashes?.tree_hash !== c.tree_hash ||
      !body.evidence_ref || typeof body.evidence_ref !== "string" ||
      body.evidence_ref.length > 2048 ||
      state.reviews[body.candidate_id]?.verdict === "CHANGES_REQUIRED" ||
      state.blocker || state.verification_phase ||
      Object.values(state.dispatches).some(d => !["released","result_reconciled","abandoned_reconciled"].includes(d.status))) {
    throw new Error("SOLO_CI: require immutable candidate, bound exact head, live SUCCESS CI, settled dispatches and no blockers")
  }
}
