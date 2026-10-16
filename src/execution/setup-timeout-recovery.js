// Strict one-shot recovery for a frozen verification setup that timed out.
// A blocked execution cannot run its declared check normally; allow one
// bounded root-owned attempt after independently verifying immutable FAIL
// receipts from this exact candidate, WU, check, and setup command.
// Never call an undeclared "install" check, waive setup, extend a timeout,
// accept setup-only success as PASS, or clear a blocker on FAIL.
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { readVerificationReceipt, writeVerificationReceipt, createVerificationReceipt } from "./verification-results.js"
import { verificationContractHash } from "./verification-contract.js"
import { withVerificationBudget } from "./verification-budget.js"
import { runCandidateVerification } from "./verification.js"

const evidencePattern = /^verify-[a-f0-9]{64}\.json$/
const historicalSetupCause = /(?:npm|install|setup|verification|timeout|timed out|sigkill)/i

async function findFailedSetupEvidence(dir, candidate, checkId) {
  let entries
  try { entries = (await readdir(dir)).filter(name => evidencePattern.test(name)) }
  catch (error) { if (error.code === "ENOENT") throw new Error("SETUP_RECOVERY_NO_RECEIPTS: no recorded setup failure"); throw error }
  if (entries.length > 5000) throw new Error("SETUP_RECOVERY_RECEIPT_LIMIT: narrow the historical evidence before retry")
  const declared = candidate.verification_contract?.setup ?? []
  const expectedContract = candidate.manifest?.verification_contract?.contract_hash
  for (const name of entries.sort()) {
    const receipt = await readVerificationReceipt(dir, name.slice(0, -5))
    if (receipt?.candidate_id !== candidate.candidate_id || receipt.check_id !== checkId ||
        receipt.status !== "FAIL" || receipt.verification_contract_hash !== expectedContract) continue
    const badSetup = receipt.output?.setup_results?.find(out =>
      declared.some(spec => spec.id === out.id) &&
      out.ok === false && out.timedOut === true)
    if (badSetup) return { evidence_id: receipt.evidence_id, setup_id: badSetup.id }
  }
  throw new Error("SETUP_RECOVERY_NO_MATCHING_TIMEOUT: no immutable timed-out setup receipt for this candidate/check")
}

export async function retryBlockedFrozenVerification({
  controller, candidate, checkId, context, runtimeSession, receiptsDir,
  run = (candidate, checkId, options) => runCandidateVerification(candidate, checkId, options),
}) {
  const sessionID = context?.sessionID
  if (!sessionID || runtimeSession?.id !== sessionID || runtimeSession.parentID ||
      runtimeSession.agent !== "harness-orchestrator") {
    throw new Error("SETUP_RECOVERY_ROOT_REQUIRED: only the actual root orchestrator may retry blocked setup")
  }
  const { state } = await controller.snapshot()
  const blocker = state.blocker
  const contract = candidate.verification_contract
  if (!blocker || blocker.class !== "BLOCKED_TOOLING" || state.completed || state.wu?.completed ||
      !state.wu || state.wu.wu_id !== contract?.source_wu_id ||
      !state.candidates?.[candidate.candidate_id] ||
      state.candidates[candidate.candidate_id].wu_id !== state.wu.wu_id ||
      !Array.isArray(contract?.setup) || contract.setup.length === 0 ||
      !contract.commands?.some(c => c.id === checkId) ||
      verificationContractHash(contract) !== state.wu.contract?.verification_contract_hash ||
      !historicalSetupCause.test(blocker.reason ?? "")) {
    throw new Error("SETUP_RECOVERY_INELIGIBLE: exact frozen check, setup-timeout tooling cause and active WU required")
  }
  if (state.verification_retry?.blocked_at_revision === blocker.at_revision) {
    throw new Error("VERIFICATION_RETRY_ALREADY_ATTEMPTED: do not repeat a failed recovery without new evidence")
  }
  const failure = await findFailedSetupEvidence(receiptsDir, candidate, checkId)
  const lease = await controller.acquire(sessionID)
  const latest = await controller.snapshot()
  if (latest.state.revision !== state.revision || latest.state.blocker?.at_revision !== blocker.at_revision) {
    throw new Error("SETUP_RECOVERY_STALE: controller/blocker changed while validating immutable evidence")
  }
  const attemptID = `${latest.state.execution_id}:verification-setup-retry:${blocker.at_revision}`
  await controller.commit({
    operation_id: attemptID,
    operation_type: "VERIFICATION_RETRY_ATTEMPT",
    body: {
      blocked_at_revision: blocker.at_revision, wu_id: state.wu.wu_id,
      candidate_id: candidate.candidate_id, check_id: checkId,
      verification_contract_hash: state.wu.contract.verification_contract_hash,
      failure_evidence_id: failure.evidence_id, setup_id: failure.setup_id,
    },
  }, {
    holder_session_id: sessionID, expected_revision: latest.state.revision, lease_fencing_token: lease.fencing_token,
  })

  const result = await withVerificationBudget({
    controller, candidate, check_id: checkId, context, runtimeSession,
    setupRecovery: { kind: "VERIFIED_SETUP_TIMEOUT",
      blocked_at_revision: blocker.at_revision, source_wu_id: state.wu.wu_id, check_id: checkId },
    run: options => run(candidate, checkId, options),
  })
  let evidence_id = null
  if (result.status === "PASS" || result.status === "FAIL") {
    const receipt = createVerificationReceipt(result)
    await writeVerificationReceipt(receiptsDir, receipt)
    evidence_id = receipt.evidence_id
  }
  if (result.status !== "PASS") return { ...result, evidence_id,
    recovery: "UNRESOLVED_SETUP_RETRY_FAILED", blocked_at_revision: blocker.at_revision }

  // Full declared check PASS (including frozen setup) is the only clearance.
  // Receipt write must succeed before the append-only blocker-resolution event.
  if (!evidence_id) throw new Error("SETUP_RECOVERY_PASS_WITHOUT_RECEIPT")
  const clearLease = await controller.acquire(sessionID)
  const current = await controller.snapshot()
  if (current.state.blocker?.class !== "BLOCKED_TOOLING" ||
      current.state.blocker.at_revision !== blocker.at_revision ||
      current.state.verification_phase || current.state.budget.active_phase ||
      current.state.wu?.wu_id !== state.wu.wu_id) {
    throw new Error("SETUP_RECOVERY_STATE_CHANGED: PASS saved; blocker must be reviewed before clearance")
  }
  await controller.commit({
    operation_id: `${attemptID}:clear`, operation_type: "CLEAR_BLOCKER",
    body: { blocker_class: "BLOCKED_TOOLING", blocked_at_revision: blocker.at_revision,
      resolution: `Full frozen ${checkId} verification and declared setup PASS after prior timed-out ${failure.setup_id}; receipt ${evidence_id}`,
      recovery_evidence: { failed_receipt_id: failure.evidence_id, pass_receipt_id: evidence_id,
        candidate_id: candidate.candidate_id, check_id: checkId } },
  }, {
    holder_session_id: sessionID, expected_revision: current.state.revision, lease_fencing_token: clearLease.fencing_token,
  })
  return { ...result, evidence_id, recovery: "TOOLING_BLOCKER_RESOLVED",
    blocked_at_revision: blocker.at_revision }
}
