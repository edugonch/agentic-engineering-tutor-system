import { applicableAuthority } from "./process-recovery.js"
import { tddGate } from "./tdd-preflight.js"
import { epicExecutionRemaining } from "./time-policy.js"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { createExecutionController } from "./execution.js"

// Durations are planning and observability estimates, not execution deadlines.
// Preserve exact child ownership and recovery; never interrupt or block by time.
export function createWorkerBudgetGuard(ctx, projectRoot, recovery, { now = () => Date.now() } = {}) {
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
        const nowMs = now()
        const observed = Number.isFinite(start) ? Math.max(0, (nowMs - start) / 1000) : null
        const remaining = epicExecutionRemaining(state, { worker: d, nowMs })
        return { execution_id: e.name, wu_id: state.wu?.wu_id, dispatch_id: dispatchID,
          time_policy: "planning_estimate", enforced: false,
          remaining_execution_seconds: Math.max(0, Math.floor(remaining)),
          remaining_reservation_seconds: observed === null ? null : Math.max(0, Math.floor(d.reserved_seconds - observed)),
          estimate_exceeded: observed !== null && observed > d.reserved_seconds,
          estimate_overrun_seconds: observed === null ? null : Math.max(0, observed - d.reserved_seconds),
          contract: state.wu?.contract ? { source_hash: state.wu.contract.source_hash,
            verification_contract: state.wu.contract.verification_contract, process_obligations: state.wu.contract.process_obligations } : null,
          tdd_gate: tddGate(state),
          ...applicableAuthority(state),
          authority_resolution: state.authority_resolutions?.[state.wu?.wu_id]?.at(-1) ?? null }
      }
    }
  }
  return { inspect, failures: () => [...failures],
    release(_sessionID) { /* no deadline timer: child lifecycle is managed by dispatch state */ },
    dispose() { /* no deadline timer */ } }
}
