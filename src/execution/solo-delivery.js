// CI is informational only. An owner-approved Solo Developer policy names
// low-risk WUs and the local verification checks that are sufficient for each.
// No LLM review, GitHub Actions status, or undocumented command is an authority.
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { readVerificationReceipt } from "./verification-results.js"

const ID = /^[A-Za-z0-9._:-]{1,181}$/
const SHA = /^[a-f0-9]{64}$/
const HEAD = /^[a-f0-9]{40}$/
const cleanList = a => Array.isArray(a) && a.length >= 1 && a.length <= 20 &&
  a.every(id => typeof id === "string" && ID.test(id)) && new Set(a).size === a.length

export function validSoloPolicy(p) {
  if (!p || Array.isArray(p) || typeof p !== "object" || !ID.test(p.execution_id ?? "") ||
      !ID.test(p.mandate_id ?? "")) return false
  if (p.mode === "SOLO_CI") return Object.keys(p).sort().join(",") ===
    "ci_check,eligible_wu_ids,execution_id,mandate_id,mode" &&
    ID.test(p.ci_check ?? "") && cleanList(p.eligible_wu_ids) ||
    (p.mode === "SOLO_CI" && Object.keys(p).length === 5 && ID.test(p.ci_check ?? "") &&
      Array.isArray(p.eligible_wu_ids) && p.eligible_wu_ids.length <= 100 &&
      p.eligible_wu_ids.length >= 1 && p.eligible_wu_ids.every(x => typeof x === "string" && ID.test(x)) &&
      new Set(p.eligible_wu_ids).size === p.eligible_wu_ids.length &&
      Object.keys(p).sort().join(",") === "ci_check,eligible_wu_ids,execution_id,mandate_id,mode")
  if (p.mode !== "SOLO_LOCAL" || Object.keys(p).sort().join(",") !==
      "checks_by_wu,execution_id,mandate_id,mode" || !p.checks_by_wu ||
      Array.isArray(p.checks_by_wu) || typeof p.checks_by_wu !== "object") return false
  const entries = Object.entries(p.checks_by_wu)
  return entries.length > 0 && entries.length <= 100 &&
    entries.every(([wuId, checks]) => ID.test(wuId) && cleanList(checks))
}

export function soloCandidateEligible(state, candidateId) {
  const p = state.solo_delivery?.policy
  const c = state.candidates?.[candidateId]
  return validSoloPolicy(p) && p.mode === "SOLO_LOCAL" && !state.completed &&
    state.wu && !state.wu.completed && !state.wu.batch &&
    state.mandate?.authority_kind === "OWNER_APPROVED_EPIC" &&
    state.mandate.mandate_id === p.mandate_id &&
    state.execution_id === p.execution_id + ":exec" &&
    state.wu.wu_id === c?.wu_id &&
    Object.hasOwn(p.checks_by_wu, c.wu_id) && !c.superseded_by_contract &&
    p.checks_by_wu[c.wu_id].every(id => c.required_check_ids?.includes(id))
}

export function soloAccepted(state, candidateId, { historicalReplay = false } = {}) {
  const proof = state.solo_acceptances?.[candidateId]
  const c = state.candidates?.[candidateId]
  const binding = state.pr_binding
  if (!proof || !c || !binding || binding.candidate_id !== candidateId ||
      !HEAD.test(proof.head_sha ?? "") || proof.head_sha !== binding.head_sha ||
      proof.candidate_hashes?.tree_hash !== c.tree_hash ||
      proof.candidate_hashes?.manifest_hash !== c.manifest_hash) return false
  if (historicalReplay && proof.basis === "LIVE_GITHUB_CI") {
    // Replay-only compatibility for historical SOLO_CI accepted work. Old
    // provenance is retained, but cannot authorize a NEW remote merge.
    const old = state.solo_delivery_history?.find(x => x.source_hash === proof.source_hash) ?? state.solo_delivery
    return old?.policy?.mode === "SOLO_CI" && old.source_hash === proof.source_hash &&
      old.policy.ci_check === proof.ci_check && proof.conclusion === "SUCCESS"
  }
  return soloCandidateEligible(state, candidateId) && proof.basis === "LOCAL_VERIFICATION" &&
    proof.source_hash === state.solo_delivery.source_hash &&
    proof.verification_contract_hash === c.verification_contract_hash &&
    Array.isArray(proof.verification_evidence_ids) &&
    proof.verification_evidence_ids.length === state.solo_delivery.policy.checks_by_wu[c.wu_id].length &&
    JSON.stringify([...proof.verified_check_ids].sort()) ===
      JSON.stringify([...state.solo_delivery.policy.checks_by_wu[c.wu_id]].sort())
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
  if (soloAccepted(state, candidateId, { historicalReplay })) return { allowed: true, route: "SOLO_LOCAL" }
  return { allowed: false, reason: soloCandidateEligible(state, candidateId)
    ? "local verification acceptance not recorded" : "no PASS review" }
}

export function assertSoloAcceptanceEvent(state, body) {
  if (!soloCandidateEligible(state, body.candidate_id))
    throw new Error("SOLO_LOCAL: candidate is not in the exact approved WU/check list")
  const c = state.candidates[body.candidate_id]
  const selected = state.solo_delivery.policy.checks_by_wu[c.wu_id]
  if (!state.pr_binding || state.pr_binding.candidate_id !== body.candidate_id ||
      state.pr_binding.head_sha !== body.head_sha || !HEAD.test(body.head_sha ?? "") ||
      body.basis !== "LOCAL_VERIFICATION" || body.source_hash !== state.solo_delivery.source_hash ||
      body.verification_contract_hash !== c.verification_contract_hash ||
      body.candidate_hashes?.manifest_hash !== c.manifest_hash ||
      body.candidate_hashes?.tree_hash !== c.tree_hash ||
      !Array.isArray(body.verification_evidence_ids) || !Array.isArray(body.verified_check_ids) ||
      body.verification_evidence_ids.length !== selected.length ||
      new Set(body.verification_evidence_ids).size !== selected.length ||
      JSON.stringify([...body.verified_check_ids].sort()) !== JSON.stringify([...selected].sort()) ||
      [ "CHANGES_REQUIRED", "BLOCKED" ].includes(state.reviews?.[body.candidate_id]?.verdict) ||
      state.blocker || state.verification_phase ||
      Object.values(state.dispatches).some(d => !["released","result_reconciled","abandoned_reconciled"].includes(d.status))) {
    throw new Error("SOLO_LOCAL: exact candidate, selected PASS receipts, no blockers and settled work required")
  }
}

// An observation of tamper-checked runner receipts. Never substitutes a text
// description, GitHub check, model assertion or the fact that a command exists.
export async function collectLocalSoloEvidence(projectRoot, state, candidateId) {
  if (!soloCandidateEligible(state, candidateId)) throw new Error("SOLO_LOCAL: WU/check scope not approved")
  const c = state.candidates[candidateId]
  const ids = state.solo_delivery.policy.checks_by_wu[c.wu_id]
  const directory = join(projectRoot, ".harness", "execution", "verification-results")
  let files
  try { files = await readdir(directory) } catch (e) {
    if (e.code === "ENOENT") throw new Error("SOLO_LOCAL: missing local verification receipts")
    throw e
  }
  const found = new Map()
  for (const file of files.sort()) {
    if (!/^verify-[a-f0-9]{64}\.json$/.test(file)) continue
    const receipt = await readVerificationReceipt(directory, file.slice(0, -5))
    if (receipt.candidate_id !== candidateId ||
        receipt.verification_contract_hash !== c.verification_contract_hash ||
        !ids.includes(receipt.check_id) || receipt.status !== "PASS" ||
        receipt.exit_code !== 0 || receipt.output?.timed_out === true ||
        receipt.output?.aborted === true) continue
    if (!found.has(receipt.check_id)) found.set(receipt.check_id, receipt.evidence_id)
  }
  if (ids.some(id => !found.has(id))) throw new Error("SOLO_LOCAL: missing PASS receipt for checks " +
    ids.filter(id => !found.has(id)).join(","))
  return { verification_evidence_ids: ids.map(id => found.get(id)), verified_check_ids: [...ids] }
}
