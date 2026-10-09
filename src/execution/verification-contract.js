// Verification-contract identity (neutral module: no imports from candidate.js
// or verification.js, so both can depend on it without cycles).
//
// A frozen verification contract carries provenance (which WU authorized it) and
// a normative content hash over exactly what can run: commands (program+args),
// capabilities, and environment. The reviewer cannot change any of these; the
// contract_hash binds the review to the exact checks that were authorized.

import { stableHash } from "./serialize.js"

export function verificationContractHash(contract) {
  const normative = {
    commands: (contract?.commands ?? []).map((check) => ({
      id: check.id,
      program: check.program,
      args: check.args,
      ...(check.timeout_ms !== undefined ? { timeout_ms: check.timeout_ms } : {}),
    })),
    ...(contract?.setup ? { setup: contract.setup } : {}),
    capabilities: contract?.capabilities ?? [],
    environment: contract?.environment ?? {},
  }
  return stableHash(normative)
}
