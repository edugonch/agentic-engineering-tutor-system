import { usesPlanningEstimates, epicExecutionRemaining } from "./time-policy.js"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { createExecutionController } from "./execution.js"

// Planning estimates never interrupt a worker. Only the explicit Epic budget
// remains an execution ceiling; legacy executions retain their old policy until
// an audited owner-approved transition is recorded.
export function createWorkerBudgetGuard(ctx, projectRoot, recovery, { now = () => Date.now() } = {}) {
  const timers = new Map()
  const failures = []
  async function inspect(sessionID, agent) {
    if (!agent?.startsWith("harness-") || agent === "harness-orchestrator") return
    const response = await ctx.session.get({ sessionID })
    const child = response?.data ?? response
    if (!child?.parentID || child.id !== sessionID || child.agent !== agent) return
    const root = join(projectRoot, ".harness/execution/controller")
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) }
    catch (error) { if (error.code === "ENOENT") return; throw error }
    for (const e of entries.filter(e => e.isDirectory())) {
      const controller = await createExecutionController({ dir: join(root, e.name) })
      let { state } = await controller.snapshot()
      if (state.completed) continue
      for (const [dispatchID, original] of Object.entries(state.dispatches)) {
        if (original.prepared_by_session_id !== child.parentID || original.expected_agent !== agent || !original.launch_call_id) continue
        let d = original
        if (!d.session_id && d.status === "pending_launch") {
          // Resolve only when the exact parent call already exposes this child.
          const raw = await ctx.session.context({ sessionID: child.parentID })
          const messages = raw?.data ?? raw
          const matches = (Array.isArray(messages) ? messages : []).flatMap(m => m.type === "assistant" ? m.content ?? [] : [])
            .filter(p => p.type === "tool" && p.id === d.launch_call_id && p.state?.metadata?.sessionID === sessionID)
          if (matches.length !== 1) continue
          await recovery.recover({ execution_id: e.name, dispatch_id: dispatchID, session_id: child.parentID })
          state = (await controller.snapshot()).state
          d = state.dispatches[dispatchID]
        }
        if (d.session_id !== sessionID || d.status !== "launched") continue
        const start = Date.parse(d.launch_claimed_at)
        if (!Number.isFinite(start)) continue // legacy unknown interval stays conservatively reserved
        const advisory = usesPlanningEstimates(state)
        const remaining = advisory ? epicExecutionRemaining(state, { worker: d, nowMs: now() }) * 1000 : start + d.reserved_seconds * 1000 - now()
        async function expire() {
          const current = (await controller.snapshot()).state
          if (current.dispatches[dispatchID]?.status !== "launched") return
          if (usesPlanningEstimates(current) && epicExecutionRemaining(current, { worker: current.dispatches[dispatchID], nowMs: now() }) > 0) {
            await inspect(sessionID, agent)
            return
          }
          await ctx.session.interrupt({ sessionID, continue: false })
          const lease = await controller.acquire(child.parentID)
          const latest = await controller.snapshot()
          if (!latest.state.blocker && latest.state.dispatches[dispatchID]?.reservation_status === "reserved") await controller.commit({ operation_id: `${e.name}:reservation-expired:${dispatchID}`, operation_type: "BLOCK",
            body: { class: "BUDGET_EXHAUSTED", dispatch_id: dispatchID, budget_reason: advisory ? "epic_exhausted" : "reservation_expired", reason: advisory ? "Explicit Epic execution budget exhausted; WU estimate was not a cutoff" : `Dispatch ${dispatchID} reached its ${d.reserved_seconds}s reservation. Inspect terminal evidence and reconcile before allocating any remaining WU budget.` } },
            { holder_session_id: child.parentID, expected_revision: latest.state.revision, lease_fencing_token: lease.fencing_token })
        }
        if (!timers.has(sessionID)) {
          const timer = setTimeout(() => {
            timers.delete(sessionID)
            expire().catch(error => { failures.push(error.message); if (failures.length > 20) failures.shift() })
          }, Math.max(1, Math.min(remaining, 2_147_483_647)))
          timer.unref?.()
          timers.set(sessionID, timer)
        }
        if (remaining <= 0) throw new Error(`HARNESS_BUDGET_EXHAUSTED: dispatch ${dispatchID} has no remaining ${advisory ? "Epic allocation" : "reservation"}`)
        return { execution_id: e.name, wu_id: state.wu?.wu_id, dispatch_id: dispatchID,
          time_policy: advisory ? "planning_estimate" : "legacy_hard_limit",
          remaining_execution_seconds: Math.max(0, Math.floor(remaining / 1000)),
          remaining_reservation_seconds: Math.max(0, Math.floor((start + d.reserved_seconds * 1000 - now()) / 1000)),
          estimate_exceeded: now() > start + d.reserved_seconds * 1000,
          contract: state.wu?.contract ? { source_hash: state.wu.contract.source_hash,
            verification_contract: state.wu.contract.verification_contract, process_obligations: state.wu.contract.process_obligations } : null,
          authority_resolution: state.authority_resolutions?.[state.wu?.wu_id]?.at(-1) ?? null }
      }
    }
  }
  return { inspect, failures: () => [...failures], release(sessionID) { clearTimeout(timers.get(sessionID)); timers.delete(sessionID) },
    dispose() { for (const timer of timers.values()) clearTimeout(timer); timers.clear() } }
}
