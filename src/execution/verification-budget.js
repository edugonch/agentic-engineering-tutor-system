import { randomUUID } from "node:crypto"
import { wuBudgetUsage } from "./wu-budget.js"
import { verificationContractHash } from "./verification-contract.js"

// Verification inside a worker is covered by that worker's measured envelope.
// Root verification owns an ACTIVE phase, settled even on failure/cancellation.
// The timestamps are anchored to monotonic elapsed time after admission.
export async function withVerificationBudget({ controller, candidate, check_id, context, runtimeSession, launchEvidence = [], run, monotonic = () => performance.now() }) {
  const session = context?.sessionID
  if (!session) throw new Error("Verification requires a runtime session identity")
  const { state } = await controller.snapshot()
  const contract = state.wu?.contract
  if (state.completed || state.wu?.completed || state.blocker) throw new Error(`Verification cannot start: ${state.blocker?.class ?? "execution completed"}`)
  if (!contract || candidate.verification_contract?.source_wu_id !== state.wu.wu_id ||
      verificationContractHash(candidate.verification_contract) !== contract.verification_contract_hash)
    throw new Error("Verification candidate does not match the active WU contract")
  const b = state.budget, wu = wuBudgetUsage(state, state.wu.wu_id)
  if (state.verification_phase) throw new Error("HARNESS_VERIFICATION_IN_PROGRESS: observe the existing verification before starting another")
  let worker = Object.values(state.dispatches).find(d => d.session_id === session && d.status === "launched")
  // While a subagent is running, the parent may not yet have persisted LAUNCH.
  // Admit only the exact child exposed by the claimed runtime tool call. This
  // is read-only: no lease transfer, identity recovery or acceptance is implied.
  if (!worker && runtimeSession?.parentID) {
    const matches = Object.values(state.dispatches).filter(d =>
      runtimeSession.id === session && d.status === "pending_launch" && !d.session_id &&
      d.prepared_by_session_id === runtimeSession.parentID && d.expected_agent === runtimeSession.agent &&
      d.launch_call_id && (Array.isArray(launchEvidence) ? launchEvidence : []).flatMap(m =>
        m.type === "assistant" ? m.content ?? [] : []).filter(p =>
        p.type === "tool" && p.name === "subagent" && p.id === d.launch_call_id &&
        p.state?.input?.agent === d.expected_agent && p.state?.metadata?.sessionID === session).length === 1)
    if (matches.length !== 1) throw new Error("HARNESS_DISPATCH_IDENTITY_REQUIRED: verification requires the exact claimed child; inspect the parent launch evidence")
    worker = matches[0]
  }
  if (worker && worker.reservation_status !== "reserved") throw new Error("Verification requires an active worker reservation")
  const claimed = worker ? Date.parse(worker.launch_claimed_at) : NaN
  const elapsedPhase = b.active_phase === "ACTIVE" ? Math.max(0, Date.now() / 1000 - b.active_started_at) : 0
  const available = worker ? worker.reserved_seconds - (Number.isFinite(claimed) ? Math.max(0, (Date.now() - claimed) / 1000) : 0)
    : Math.min(b.total_seconds - b.used_seconds - b.reserved_seconds, wu.available_seconds ?? 0) - elapsedPhase
  if (!Number.isFinite(available) || available <= 0) return { status: "BLOCKED_BUDGET", reason: "No authorized verification allocation remains" }
  const checks = candidate.verification_contract.commands.filter(check => !check_id || check.id === check_id)
  if (!checks.length) return { status: "BLOCKED_UNDECLARED_CHECK", check_id }
  const plannedMs = (candidate.verification_contract.setup ?? []).reduce((sum, step) => sum + (step.timeout_ms ?? 300000), 0)
    + Math.max(...checks.map(check => check.timeout_ms ?? 30000))
  const authorized = Math.min(available, plannedMs / 1000)
  const ownsPhase = !worker && !b.active_phase
  if (!worker && b.active_phase && b.active_phase !== "ACTIVE") throw new Error("End the waiting phase before running verification")
  const id = `verification-${session}-${context.id ?? randomUUID()}`
  const commit = async (type, body) => {
    const lease = await controller.acquire(session), { state } = await controller.snapshot()
    return controller.commit({ operation_id: `${id}:${type}`, operation_type: type, body },
      { holder_session_id: session, expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  }
  const start = Date.now() / 1000
  if (ownsPhase) await commit("PHASE_START", { phase: "ACTIVE", started_at: start, source: "runtime.verification", session_id: session,
    authorized_seconds: authorized, owner_pid: process.pid, owner_death_guard: 1 })
  const measured = monotonic()
  try { return await run({ budgetMs: authorized * 1000, signal: context.signal }) }
  finally {
    if (ownsPhase) await commit("PHASE_END", { ended_at: start + Math.max(0, monotonic() - measured) / 1000,
      source: "runtime.verification", session_id: session, expected_phase_id: `${id}:PHASE_START` })
  }
}

// An interrupted host has no trustworthy monotonic end measurement. Retain the
// full authorized allocation, explicitly labelled; never invent a zero charge.
// The command host monitors its original parent and kills its process group.
export async function recoverVerificationPhase({ controller, session_id }) {
  const snap = await controller.snapshot(), phase = snap.state.verification_phase
  if (!phase) return { status: "NO_VERIFICATION_TO_RECOVER" }
  if (phase.owner_death_guard !== 1 || !Number.isSafeInteger(phase.owner_pid) || !Number.isFinite(phase.authorized_seconds))
    throw new Error("VERIFICATION_RECOVERY_EVIDENCE_REQUIRED: legacy phase has no owner-death guarantee")
  try {
    process.kill(phase.owner_pid, 0)
    throw new Error("VERIFICATION_OWNER_ALIVE: interrupt or observe the existing run; do not duplicate it")
  } catch (error) { if (error.code !== "ESRCH") throw error }
  // Permit the independent command host to observe parent death before settling.
  await new Promise(resolve => setTimeout(resolve, 300))
  const lease = await controller.acquire(session_id), current = await controller.snapshot()
  if (current.state.verification_phase?.operation_id !== phase.operation_id) throw new Error("Verification phase changed during recovery")
  const res = await controller.commit({ operation_id: `${phase.operation_id}:owner-death-recovery`, operation_type: "PHASE_END",
    body: { ended_at: current.state.budget.active_started_at + phase.authorized_seconds, expected_phase_id: phase.operation_id,
      source: "runtime.verification_recovery", consumption_basis: "unknown_consume_authorized_allocation", owner_pid: phase.owner_pid } },
    { holder_session_id: session_id, expected_revision: current.state.revision, lease_fencing_token: lease.fencing_token })
  return { status: "VERIFICATION_RECOVERED", revision: res.revision, charged_seconds: phase.authorized_seconds,
    consumption_basis: "unknown_consume_authorized_allocation", result: "UNKNOWN_NOT_ACCEPTANCE" }
}
