// OpenCode V2: subagent publishes metadata.sessionID via progress and results.
// session.context contains projected assistant.content tool entries, after the
// last compaction only. Missing evidence is never proof of a failed launch.
import { join } from "node:path"
import { createExecutionController } from "./execution.js"
import { stableHash } from "./serialize.js"

const unwrap = value => value?.data ?? value
const id = value => {
  const result = String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "_")
  if (!result || result === "." || result === "..") throw new Error("execution_id is required")
  return result
}
async function readRuntime(run) {
  let timer
  try {
    return await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("OpenCode session read timed out")), 5000)
    })])
  } finally { clearTimeout(timer) }
}
const key = (session, call) => JSON.stringify([session, call])

export function createSessionRecovery(ctx, projectRoot) {
  const launches = new Map()
  const cached = new Map()
  const queues = new Map()

  // Serialize our own hook/tool writes; the controller additionally enforces
  // cross-process leases, revision checks and operation idempotency.
  async function exclusive(execution, run) {
    const previous = queues.get(execution) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(run)
    queues.set(execution, next)
    try { return await next } finally { if (queues.get(execution) === next) queues.delete(execution) }
  }

  async function recover(input, observation) {
    const execution = id(input.execution_id)
    return exclusive(execution, async () => {
      if (!input.session_id) throw new Error("Runtime session identity is required")
      const controller = await createExecutionController({ dir: join(projectRoot, ".harness", "execution", "controller", execution) })
      let snap = await controller.snapshot()
      let dispatch = snap.state.dispatches[input.dispatch_id]
      if (!dispatch) throw new Error("Unknown recovery dispatch")
      if (!dispatch.claim_required || !dispatch.launch_call_id || !dispatch.prepared_by_session_id || !dispatch.expected_agent) {
        throw new Error("Recovery requires a durable launch claim with parent and agent identity")
      }
      const cacheKey = JSON.stringify([execution, input.dispatch_id, input.session_id, snap.state.revision])
      if (!observation && cached.has(cacheKey)) return { ...cached.get(cacheKey), cached: true }
      const call = dispatch.launch_call_id
      const parent = dispatch.prepared_by_session_id
      const base = { execution_id: execution, dispatch_id: input.dispatch_id, parent_session_id: parent, launch_call_id: call }
      async function commit(type, body, operation) {
        const lease = await controller.acquire(input.session_id)
        snap = await controller.snapshot()
        // Claim identity must remain unchanged throughout the recovery.
        const current = snap.state.dispatches[input.dispatch_id]
        if (current.launch_call_id !== call || current.prepared_by_session_id !== parent || current.expected_agent !== dispatch.expected_agent) {
          throw new Error("Recovery claim changed; inspect current state")
        }
        await controller.commit({ operation_id: operation, operation_type: type, body }, {
          holder_session_id: input.session_id, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token,
        })
        snap = await controller.snapshot()
        dispatch = snap.state.dispatches[input.dispatch_id]
      }
      async function checkpoint(result) {
        const note = { kind: "dispatch-session-recovery", ...base, ...result }
        await commit("CHECKPOINT", { note }, `${execution}:session-recovery:${input.dispatch_id}:${stableHash(note)}`)
      }
      async function stop(status, reason) {
        // Every step is independently durable. Re-running after a crash resumes
        // this sequence without consuming the reservation or replacing blockers.
        snap = await controller.snapshot()
        dispatch = snap.state.dispatches[input.dispatch_id]
        if (dispatch.status === "pending_launch") {
          await commit("DISPATCH_MARK_AMBIGUOUS", { dispatch_id: input.dispatch_id }, `${execution}:ambiguous:${input.dispatch_id}`)
        }
        if (!snap.state.blocker) {
          await commit("BLOCK", { class: "BLOCKED_TOOLING", reason }, `${execution}:session-recovery-block:${input.dispatch_id}:${snap.state.revision}`)
        }
        const result = { status, reason, next_action: "STOP. Preserve reservation; no relaunch or finish. Resume recovery only with new evidence or restored session capability." }
        await checkpoint(result)
        const answer = { ...base, ...result, revision: snap.state.revision, dispatch_status: dispatch.status, reservation_status: dispatch.reservation_status }
        cached.set(JSON.stringify([execution, input.dispatch_id, input.session_id, snap.state.revision]), answer)
        return answer
      }

      // Runtime caller and historical parent are verified independently: a new
      // orchestrator session can recover an old dispatch after lease expiry.
      if (typeof ctx.session?.get !== "function") return stop("CAPABILITY_UNAVAILABLE", "OpenCode session.get is unavailable")
      let caller
      try { caller = unwrap(await readRuntime(() => ctx.session.get({ sessionID: input.session_id }))) } catch { return stop("CAPABILITY_UNAVAILABLE", "OpenCode could not read the caller session") }
      if (caller?.id !== input.session_id || caller.parentID || caller.agent !== "harness-orchestrator") throw new Error("Recovery requires the actual root harness-orchestrator")

      let evidence = observation
      if (!evidence) {
        if (typeof ctx.session.context !== "function") return stop("CAPABILITY_UNAVAILABLE", "OpenCode session.context is unavailable")
        let messages
        try { messages = unwrap(await readRuntime(() => ctx.session.context({ sessionID: parent }))) } catch { return stop("CAPABILITY_UNAVAILABLE", "OpenCode could not read the launch parent's context") }
        if (!Array.isArray(messages)) return stop("EVIDENCE_INSUFFICIENT", "Unsupported OpenCode context response")
        const matches = messages.filter(m => m.type === "assistant").flatMap(m => (m.content ?? [])
          .filter(part => part.type === "tool" && part.id === call)
          .map(part => ({ ...part, message_id: m.id })))
        if (matches.length !== 1) return stop("EVIDENCE_INSUFFICIENT", "Exact launch call absent or duplicated in available context; it may have been compacted")
        const match = matches[0]
        evidence = { tool: match.name, sessionID: parent, id: call, input: match.state?.input,
          metadata: match.state?.metadata, source: "session.context", message_id: match.message_id ?? null }
      }
      if (evidence.tool !== "subagent" || evidence.sessionID !== parent || evidence.id !== call || evidence.input?.agent !== dispatch.expected_agent) {
        return stop("EVIDENCE_CONFLICT", "Runtime evidence does not match the durable parent/call/agent")
      }
      const childID = evidence.metadata?.sessionID
      if (typeof childID !== "string" || !childID.startsWith("ses")) return stop("EVIDENCE_INSUFFICIENT", "Exact launch call has no structured child session identity")
      let child
      try { child = unwrap(await readRuntime(() => ctx.session.get({ sessionID: childID }))) } catch { return stop("CAPABILITY_UNAVAILABLE", "OpenCode could not verify the child session") }
      if (child?.id !== childID || child.parentID !== parent || child.agent !== dispatch.expected_agent) {
        return stop("EVIDENCE_CONFLICT", "Child identity, parent or agent does not match the launch claim")
      }
      if (dispatch.session_id && dispatch.session_id !== childID) return stop("EVIDENCE_CONFLICT", "Dispatch already belongs to another child session")
      const proof = { source: evidence.source, parent_session_id: parent, launch_call_id: call, child_session_id: childID,
        agent: dispatch.expected_agent, message_id: evidence.message_id ?? null }
      if (!dispatch.session_id) {
        const ambiguous = dispatch.status === "ambiguous"
        const body = { dispatch_id: input.dispatch_id, session_id: childID, recovery_evidence: JSON.stringify(proof) }
        await commit(ambiguous ? "DISPATCH_RESOLVE_AMBIGUOUS_LAUNCH" : "DISPATCH_LAUNCH", body,
          `${execution}:verified-session:${input.dispatch_id}:${childID}`)
      }
      // Identity is not completion. Even completed tool metadata does not prove
      // accepted WU output, consumption, or absence of a candidate/commit/PR.
      const result = { status: "IDENTITY_CONFIRMED", child_session_id: childID, evidence: proof,
        observed_tool_status: evidence.metadata?.status ?? null,
        next_action: "Call harness_read_dispatch_handoff with this execution_id and dispatch_id to read the exact child's handoff and terminal evidence. Then verify its outcome before record_finish/reconcile; clear only a tooling blocker whose cause is resolved." }
      await checkpoint(result)
      return { ...base, ...result, revision: snap.state.revision, dispatch_status: dispatch.status, reservation_status: dispatch.reservation_status }
    })
  }

  return {
    recover,
    reset() { cached.clear() },
    track(binding) { launches.set(key(binding.session_id, binding.call_id), binding) },
    async afterTool(event) {
      if (event.tool !== "subagent") return
      const k = key(event.sessionID, event.id)
      const binding = launches.get(k)
      if (!binding) return
      try {
        // Error events may not retain progress metadata. Read the exact call's
        // persisted progress through context instead of parsing error prose.
        return await recover(binding, event.status === "completed" && event.result?.metadata?.sessionID ? {
          tool: event.tool, sessionID: event.sessionID, id: event.id, input: event.input,
          metadata: event.result?.metadata, source: "execute.after", message_id: event.messageID ?? null,
        } : undefined)
      } finally { launches.delete(k) }
    },
  }
}
