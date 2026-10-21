// Non-mutating receipt discovery. No lease, controller commit, setup or check is
// needed. An immutable receipt proves a past run, not the freshness of an
// external system; current validity remains a separate reviewer/policy decision.
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { readVerificationReceipt } from "./verification-results.js"

const RECEIPT = /^verify-[a-f0-9]{64}$/

export async function prepareReviewEvidence(root, state, { execution_id, wu_id, candidate_id, verification_evidence_ids = [] }) {
  const candidate = state.candidates?.[candidate_id]
  if (!candidate || candidate.wu_id !== wu_id) {
    return { status: "CANDIDATE_MISMATCH", execution_id, wu_id, candidate_id,
      reason: "Candidate must exist and belong to the requested WU", ready_for_review: false }
  }
  const contractHash = candidate.verification_contract_hash ??
    candidate.manifest?.verification_contract?.contract_hash ?? null
  const checks = candidate.required_check_ids ?? []
  if (!contractHash || !Array.isArray(checks) || !checks.length ||
      candidate.superseded_by_contract || state.wu?.wu_id !== wu_id || state.wu?.completed ||
      state.wu?.contract?.verification_contract_hash !== contractHash) {
    return { status: "STALE_OR_UNBOUND_CANDIDATE", execution_id, wu_id, candidate_id,
      candidate_hashes: { manifest_hash: candidate.manifest_hash, tree_hash: candidate.tree_hash },
      verification_contract_hash: contractHash, required_check_ids: checks,
      reason: "Active WU and exact verification contract must match an unsuperseded frozen candidate",
      ready_for_review: false }
  }
  if (!Array.isArray(verification_evidence_ids) ||
      !verification_evidence_ids.every(id => typeof id === "string")) {
    throw new Error("verification_evidence_ids must be an array of receipt IDs")
  }

  const directory = join(root, ".harness", "execution", "verification-results")
  let names = []
  try { names = (await readdir(directory)).filter(name => name.endsWith(".json")) }
  catch (error) { if (error.code !== "ENOENT") throw error }
  // An unexpected receipt-like filename cannot be silently skipped.
  const malformed = names.filter(name => !RECEIPT.test(name.slice(0, -5)));
  const discovered = names.filter(name => RECEIPT.test(name.slice(0, -5))).map(name => name.slice(0, -5));
  const expected = [...new Set([...discovered, ...verification_evidence_ids])].sort();
  const valid = [], rejected = [];
  if (malformed.length) rejected.push({ reason: "INVALID_RECEIPT_FILENAME", count: malformed.length });
  for (const id of expected) {
    if (!RECEIPT.test(id)) {
      rejected.push({ evidence_id: id, reason: "INVALID_RECEIPT_ID" });
      continue
    }
    try {
      const receipt = await readVerificationReceipt(directory, id)
      if (!receipt) { rejected.push({ evidence_id: id, reason: "NOT_FOUND" }); continue }
      if (receipt.evidence_id !== id) {
        rejected.push({ evidence_id: id, reason: "RECEIPT_ID_MISMATCH" }); continue
      }
      if (receipt.candidate_id !== candidate_id) {
        if (verification_evidence_ids.includes(id)) rejected.push({ evidence_id: id, reason: "OTHER_CANDIDATE" })
        continue
      }
      if (receipt.verification_contract_hash !== contractHash) {
        rejected.push({ evidence_id: id, reason: "OTHER_CONTRACT" }); continue
      }
      if (!checks.includes(receipt.check_id)) {
        rejected.push({ evidence_id: id, reason: "UNDECLARED_CHECK" }); continue
      }
      if (!["PASS", "FAIL"].includes(receipt.status)) {
        rejected.push({ evidence_id: id, reason: "INVALID_STATUS" }); continue
      }
      valid.push({ evidence_id: id, check_id: receipt.check_id, status: receipt.status,
        fingerprint: receipt.fingerprint ?? null,
        freshness: "UNKNOWN", reuse: "REQUIRES_APPLICABLE_POLICY" })
    } catch (error) {
      rejected.push({ evidence_id: id,
        reason: String(error?.message ?? error).startsWith("RECEIPT_TAMPERED:")
          ? "RECEIPT_TAMPERED" : "RECEIPT_UNREADABLE" })
    }
  }
  const pass = valid.filter(item => item.status === "PASS")
  const fail = valid.filter(item => item.status === "FAIL")
  const missing = checks.filter(check => !pass.some(receipt => receipt.check_id === check))
  return {
    status: rejected.length ? "INVALID_EVIDENCE_FOUND" :
      missing.length ? "CHECKS_WITHOUT_PASS" : "EXACT_PASS_RECEIPTS_FOUND_FRESHNESS_UNKNOWN",
    execution_id, wu_id, candidate_id, revision: state.revision,
    candidate_hashes: { manifest_hash: candidate.manifest_hash, tree_hash: candidate.tree_hash },
    wu_contract_hash: candidate.wu_contract_hash ?? null,
    verification_contract_hash: contractHash, required_check_ids: checks,
    pass_receipts: pass, fail_receipts: fail, missing_check_ids: missing,
    rejected_receipts: rejected, exact_pass_evidence_ids: pass.map(item => item.evidence_id),
    // No caller input may convert a historical PASS into a freshly valid one.
    evidence_freshness: "UNKNOWN_REQUIRES_POLICY", ready_for_review: false,
    coverage_complete_as_historical_evidence: missing.length === 0 && rejected.length === 0,
    note: "No checks executed. The independent reviewer must assess evidence freshness, policy and runtime configuration before citing IDs for PASS.",
  }
}
