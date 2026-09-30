// Immutable verification evidence receipts.
//
// harness_run_verification persists one content-addressed receipt per executed
// check so that RECORD_REVIEW can cite durable evidence instead of a
// caller-declared "PASS". Receipts are write-once and named by their own hash:
//
//   .harness/execution/verification-results/verify-<evidence_hash>.json
//
// evidence_id is derived from evidence_hash, so any post-write tamper breaks the
// filename/content correspondence and fails readVerificationReceipt.

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { stableSerialize } from "./serialize.js"

const sha256 = (value) => createHash("sha256").update(value).digest("hex")

// Hash over the receipt identity fields only. Both createVerificationReceipt
// (from a runner result) and readVerificationReceipt (from a stored receipt)
// feed the SAME shape here so the recomputation always matches.
function receiptEvidenceHash(identity) {
  return sha256(stableSerialize({
    candidate_id: identity.candidate_id ?? null,
    verification_contract_hash: identity.verification_contract_hash ?? null,
    check_id: identity.check_id ?? null,
    status: identity.status ?? null,
    exit_code: identity.exit_code ?? null,
    fingerprint: identity.fingerprint ?? null,
  }))
}

// Build the immutable receipt from a runCandidateVerification result. Only the
// identity fields participate in the hash; stdout/stderr stay out of the digest
// (they are evidence detail, not identity).
export function createVerificationReceipt(result) {
  const evidence_hash = receiptEvidenceHash({
    candidate_id: result.candidate_id ?? null,
    verification_contract_hash: result.verification_contract_hash ?? null,
    check_id: result.check_id ?? null,
    status: result.status ?? null,
    exit_code: result.exitCode ?? null,
    fingerprint: result.fingerprint ?? null,
  })
  return {
    evidence_id: `verify-${evidence_hash}`,
    evidence_hash,
    candidate_id: result.candidate_id ?? null,
    verification_contract_hash: result.verification_contract_hash ?? null,
    check_id: result.check_id ?? null,
    status: result.status ?? null,
    exit_code: result.exitCode ?? null,
    fingerprint: result.fingerprint ?? null,
  }
}

export async function writeVerificationReceipt(dir, receipt) {
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${receipt.evidence_id}.json`)
  await writeFile(path, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })
  return receipt.evidence_id
}

export async function readVerificationReceipt(dir, evidenceId) {
  let receipt
  try {
    receipt = JSON.parse(await readFile(join(dir, `${evidenceId}.json`), "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
  const recomputed = receiptEvidenceHash(receipt)
  if (recomputed !== receipt.evidence_hash || `verify-${recomputed}` !== evidenceId) {
    throw new Error(`RECEIPT_TAMPERED: ${evidenceId} no longer hashes to its filename/content.`)
  }
  return receipt
}
