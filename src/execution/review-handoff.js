import { stableHash } from "./serialize.js"
// New PASS records can require verifiable independent reviewer handoffs.
// Existing event replay is unaffected: this check runs only before a new commit.
export function assertTrustedReviewHandoff(state, input) {
  const d = state.dispatches?.[input.review_dispatch_id]
  const candidate = state.candidates?.[input.candidate_id]
  if (!d || !candidate || d.expected_agent !== "harness-reviewer" ||
      d.status !== "result_reconciled" || d.wu_id !== candidate.wu_id ||
      !d.session_id || d.session_id === d.prepared_by_session_id ||
      !d.handoff?.content_hash || d.handoff.truncated) {
    throw new Error("REVIEW_HANDOFF_REQUIRED: independent reconciled harness-reviewer dispatch and complete handoff required for PASS")
  }
  const lines = String(d.handoff.content ?? "").split(/\r?\n/).filter(line => line.startsWith("review_attestation: "))
  if (lines.length !== 1) throw new Error("REVIEW_HANDOFF_REQUIRED: exactly one review_attestation JSON line required")
  let a
  try { a = JSON.parse(lines[0].slice("review_attestation: ".length)) }
  catch { throw new Error("REVIEW_HANDOFF_INVALID: malformed JSON") }
  if (a.verdict !== "PASS" || a.candidate_id !== input.candidate_id ||
      a.tree_hash !== candidate.tree_hash ||
      stableHash((a.evidence_ids ?? []).slice().sort()) !== stableHash((input.verification_evidence_ids ?? []).slice().sort())) {
    throw new Error("REVIEW_HANDOFF_MISMATCH: exact candidate, tree hash and PASS evidence must agree")
  }
  return { review_dispatch_id: input.review_dispatch_id, handoff_hash: d.handoff.content_hash }
}
