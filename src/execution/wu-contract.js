import { validateVerificationContract } from "./verification.js"
import { verificationContractHash } from "./verification-contract.js"
import { stableHash } from "./serialize.js"

export function compileWuContract(wuId, definition) {
  const { content, ...source } = definition
  const lines = content.split(/\r?\n/).filter(l => l.startsWith("execution_contract: "))
  if (lines.length > 1) throw new Error("Duplicate execution_contract")
  const typed = lines.length ? JSON.parse(lines[0].slice("execution_contract: ".length)) : null
  const durations = [...content.matchAll(/^\s*-?\s*Active-time limit:\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\s*$/gim)]
  if (durations.length > 1) throw new Error("Ambiguous WU budget")
  const match = durations[0]
  const documented = match ? Number(match[1]) * (/^(h|hour)/i.test(match[2]) ? 3600 : /^(m|min)/i.test(match[2]) ? 60 : 1) : null
  const seconds = typed?.active_seconds ?? documented
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("WU contract requires a finite active_seconds or Active-time limit")
  if (documented !== null && documented !== seconds) throw new Error("WU documented and executable budgets disagree")
  const verification = typed?.verification_contract ?? null
  if (typed?.external_wait_seconds !== undefined && (!Number.isSafeInteger(typed.external_wait_seconds) || typed.external_wait_seconds <= 0)) throw new Error("external_wait_seconds must be a positive integer")
  if (verification) validateVerificationContract(verification)
  const contract = { schema_version: 1, wu_id: wuId, active_seconds: seconds, ...source,
    external_wait_seconds: typed?.external_wait_seconds ?? 1800,
    verification_contract: verification, verification_contract_hash: verification ? verificationContractHash(verification) : null,
    process_obligations: typed?.process_obligations ?? [],
    source_content: content, normalization_required: !verification }
  return { ...contract, contract_hash: stableHash(contract) }
}
