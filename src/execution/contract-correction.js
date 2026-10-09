import { stableHash } from "./serialize.js"
import { verificationContractHash } from "./verification-contract.js"
import { validateVerificationContract } from "./verification.js"

// Corrections are explicit new events, never replacement of frozen evidence.
export function validateContractCorrection(state, body) {
  const old = state.wu?.contract, next = body.contract
  if (!old?.verification_contract_hash || state.wu.completed || state.completed || next?.wu_id !== state.wu.wu_id)
    throw new Error("Contract correction requires the active compiled WU")
  if (body.expected_contract_hash !== old.contract_hash) throw new Error("Stale contract correction baseline")
  if (!body.reason?.trim() || next.source_authority !== "APPROVED" || !next.source_record_key || !/^[a-f0-9]{64}$/.test(next.source_hash ?? ""))
    throw new Error("Contract correction requires a reason and approved source provenance")
  const { contract_hash, ...unsigned } = next
  if (stableHash(unsigned) !== contract_hash) throw new Error("Invalid corrected contract hash")
  if (state.budget.active_phase || state.verification_phase || state.external_wait || state.merge ||
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
  if (stableHash(before.environment ?? {}) !== stableHash(after.environment ?? {})) throw new Error("Correction cannot change environment policy")
  const mapping = body.check_mapping ?? {}, ids = new Set(after.commands.map(c => c.id))
  if (Object.keys(mapping).length !== before.commands.length || before.commands.some(c =>
      !Array.isArray(mapping[c.id]) || !mapping[c.id].length || mapping[c.id].some(id => !ids.has(id))) ||
      [...ids].some(id => !Object.values(mapping).flat().includes(id)))
    throw new Error("Correction requires complete old-to-new check mapping; no dropped verification gate")
}
