// Read-only consolidated repair bundle from an independently reconciled review.
// This helper provides no new WU, authority, or right to modify verification.
export function classifyRepairCause(message) {
  const m = String(message ?? "")
  if (/EACCES|EPERM|cache.*permission|npm.*lockfile/i.test(m)) return "RUNNER_SETUP"
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(m)) return "NETWORK"
  if (/execution_contract|active_seconds|wu_artifact_id|check_mapping|SETUP_CHANGE_REQUIRES/i.test(m)) return "CONTRACT_SCHEMA"
  if (/BLOCKED_AUTHORITY|owner approval|approved substitution/i.test(m)) return "AUTHORITY"
  if (/remote.*pending|CI_PENDING|external observation/i.test(m)) return "EXTERNAL"
  return "PRODUCT_DEFECT"
}
export function inspectRepairBundle(state, reviewDispatchId, candidateId) {
  const d = state.dispatches?.[reviewDispatchId]
  const candidate = state.candidates?.[candidateId]
  if (!d || !candidate || d.status !== "result_reconciled" ||
      d.expected_agent !== "harness-reviewer" || !d.handoff?.content_hash ||
      d.handoff.truncated || !d.session_id || d.session_id === d.prepared_by_session_id ||
      d.wu_id !== candidate.wu_id) {
    throw new Error("REPAIR_BUNDLE_REVIEW_REQUIRED: exact independent reconciled review required")
  }
  const lines = String(d.handoff.content ?? "").split(/\r?\n/).filter(l=>l.startsWith("review_findings: "))
  if (lines.length !== 1) throw new Error("REPAIR_BUNDLE_FINDINGS_REQUIRED: one review_findings JSON line required")
  let body
  try { body = JSON.parse(lines[0].slice("review_findings: ".length)) }
  catch { throw new Error("REPAIR_BUNDLE_INVALID_JSON: malformed reviewer findings") }
  if (body.candidate_id !== candidateId || body.tree_hash !== candidate.tree_hash ||
      !Array.isArray(body.findings) || body.findings.length === 0 || body.findings.length > 40 ||
      body.findings.some(f=>!f.id || !f.description || !["critical","high","medium","low"].includes(f.severity))) {
    throw new Error("REPAIR_BUNDLE_MISMATCH: exact candidate/hash and bounded findings required")
  }
  return { status:"CHANGES_REQUIRED", wu_id:candidate.wu_id, candidate_id:candidateId,
    review_dispatch_id:reviewDispatchId, handoff_hash:d.handoff.content_hash,
    findings:body.findings.map(f=>({id:String(f.id), severity:f.severity,
      category:classifyRepairCause(f.description),
      path: typeof f.path === "string" ? f.path : null,
      description:String(f.description), evidence_refs:Array.isArray(f.evidence_refs) ? f.evidence_refs.slice(0,10) : []})),
    next_action:"One builder repair dispatch within the SAME WU, addressing all bounded technical findings; new frozen candidate and fresh independent review required."
  }
}
