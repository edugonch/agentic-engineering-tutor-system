import { hasUnsettledIntegration } from "./process-recovery.js"
import { stableHash } from "./serialize.js"
import { verificationContractHash } from "./verification-contract.js"
import { validateVerificationContract } from "./verification.js"

// Corrections are explicit new events, never replacement of frozen evidence.
export function validateContractCorrection(state, body) {
  const old = state.wu?.contract, next = body.contract
  if (!old?.verification_contract_hash || state.wu.completed || state.completed || next?.wu_id !== state.wu.wu_id)
    throw new Error("Contract correction requires the active compiled WU")
  if (body.expected_contract_hash !== old.contract_hash) throw new Error("Stale contract correction baseline")
  const authority = body.mode === "verification_only" ? next.correction_source : next
  if (!body.reason?.trim() || (authority?.source_authority !== "APPROVED" && !(authority?.source_authority === "DELEGATED_TECHNICAL" && state.process_policy?.policy?.technical_verification && authority.policy_source_hash === state.process_policy.source_hash)) || !authority.source_record_key || !/^[a-f0-9]{64}$/.test(authority.source_hash ?? ""))
    throw new Error("Contract correction requires a reason and approved source provenance")
  const { contract_hash, ...unsigned } = next
  if (stableHash(unsigned) !== contract_hash) throw new Error("Invalid corrected contract hash")
  if (body.mode === "verification_only") {
    const { contract_hash: sourceHash, ...source } = authority
    if (stableHash(source) !== sourceHash || authority.wu_id !== old.wu_id ||
        stableHash(deriveVerificationCorrection(old, authority)) !== stableHash(next))
      throw new Error("Verification-only correction must retain the exact original contract and approved proposal")
  }
  if (state.budget.active_phase || state.verification_phase || hasUnsettledIntegration(state) ||
      Object.values(state.dispatches).some(d => !["released", "result_reconciled"].includes(d.status)))
    throw new Error("Contract correction requires settled dispatches, phases and merge")
  if (state.blocker && state.blocker.class !== "BLOCKED_TOOLING") throw new Error("Resolve non-tooling authority before correcting verification")
  // Keep the approved outcome, acceptance and original budget text verbatim.
  const prose = content => {
    // Knowledge records prepend metadata/title; versioned records may embed a
    // previous envelope. These generated fields are provenance, not WU scope.
    const envelope = /^---\r?\nartifact_id: [^\n]+\r?\nartifact_type: "work-unit"\r?\n[\s\S]*?\r?\n---\r?\n\r?\n# [^\n]+\r?\n\r?\n/
    while (envelope.test(content)) content = content.replace(envelope, "")
    return content.split(/^execution_contract: /m)[0].trim()
  }
  if (!old.source_content || prose(old.source_content) !== prose(next.source_content) ||
      old.active_seconds !== next.active_seconds || old.external_wait_seconds !== next.external_wait_seconds ||
      stableHash(old.process_obligations) !== stableHash(next.process_obligations))
    throw new Error("Contract correction must preserve scope, acceptance, budget and process obligations")
  validateVerificationContract(next.verification_contract)
  if (verificationContractHash(next.verification_contract) !== next.verification_contract_hash ||
      next.verification_contract_hash === old.verification_contract_hash) throw new Error("Correction requires a changed valid verification contract")
  const before = old.verification_contract, after = next.verification_contract
  if (authority.source_authority === "DELEGATED_TECHNICAL") {
    // Automatically delegated edits can add checks, never replace/drop a gate,
    // setup prerequisite or capability. Semantic substitutions need their own
    // already-approved source, rather than a model's assertion of equivalence.
    if (stableHash(before.setup ?? []) !== stableHash(after.setup ?? []) || stableHash(before.capabilities ?? []) !== stableHash(after.capabilities ?? []) ||
        before.commands.some(check => !after.commands.some(nextCheck => stableHash(check) === stableHash(nextCheck))))
      throw new Error("Delegated correction must preserve every existing check, setup and capability; add coverage or use an applicable approved substitution")
  }
  if (stableHash(before.environment ?? {}) !== stableHash(after.environment ?? {})) throw new Error("Correction cannot change environment policy")
  const mapping = body.check_mapping ?? {}, ids = new Set(after.commands.map(c => c.id))
  if (Object.keys(mapping).length !== before.commands.length || before.commands.some(c =>
      !Array.isArray(mapping[c.id]) || !mapping[c.id].length || mapping[c.id].some(id => !ids.has(id))) ||
      [...ids].some(id => !Object.values(mapping).flat().includes(id)))
    throw new Error("Correction requires complete old-to-new check mapping; no dropped verification gate")
}

// The proposal authorizes executable verification only. Never replace its
// surrounding prose with a guessed semantic equivalent of the original WU.
export function deriveVerificationCorrection(old, approved) {
  const { contract_hash: _hash, ...original } = old
  const next = { ...original, verification_contract: approved.verification_contract,
    verification_contract_hash: approved.verification_contract_hash,
    correction_source: approved }
  return { ...next, contract_hash: stableHash(next) }
}

export function correctionCheckMapping(before, after, provided) {
  if (provided) {
    const mapping = { ...provided }
    // Setup isn't a verification check; tolerate unchanged setup self-mappings.
    for (const step of before.setup ?? []) {
      if (JSON.stringify(mapping[step.id]) === JSON.stringify([step.id])) delete mapping[step.id]
    }
    return mapping
  }
  const newIds = new Set(after.commands.map(c => c.id)), mapping = {}
  const missing = before.commands.filter(c => !newIds.has(c.id))
  for (const check of before.commands) if (newIds.has(check.id)) mapping[check.id] = [check.id]
  const added = [...newIds].filter(id => !before.commands.some(c => c.id === id))
  if (missing.length === 1 && added.length) mapping[missing[0].id] = added
  else if (!missing.length && added.length && before.commands.length) mapping[before.commands[0].id].push(...added)
  else if (missing.length || added.length) throw new Error("CHECK_MAPPING_REQUIRED: supply explicit old-to-new check IDs; multiple replacements are ambiguous. No owner approval is needed to describe the mapping.")
  return mapping
}
