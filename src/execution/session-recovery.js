// OpenCode V2: subagent publishes metadata.sessionID via progress and results.
// session.context contains projected assistant.content tool entries, after the
// last compaction only. Missing evidence is never proof of a failed launch.
import { join } from "node:path"
import { readdir } from "node:fs/promises"
import { createExecutionController } from "./execution.js"
import { stableHash } from "./serialize.js"
import { findApprovedDispatchAbandonment } from "../project-knowledge.js"

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


/**
 * Fail-closed durable tool boundary. The journal fence is authoritative across
 * plugin restarts: no in-memory flag or old session outcome can unfence a child.
 * An unreadable existing controller is not assumed to be safe.
 */
export async function assertSessionNotOrphanFenced(projectRoot, sessionID) {
  if (!sessionID) throw new Error("ORPHAN_FENCE_IDENTITY_REQUIRED")
  const dir = join(projectRoot, ".harness", "execution", "controller")
  let executions
  try { executions = await readdir(dir, { withFileTypes: true }) }
  catch (error) { if (error.code === "ENOENT") return; throw error }
  for (const entry of executions) {
    if (!entry.isDirectory()) continue
    const controller = await createExecutionController({ dir: join(dir, entry.name) })
    const { state } = await controller.snapshot()
    if (Object.values(state.dispatches).some(d => d.fence?.child_session_id === sessionID)) {
      throw new Error("ORPHAN_CHILD_FENCED: this child was abandoned and may not execute further tools")
    }
  }
}
const unresolvedTools = messages => (Array.isArray(messages) ? messages : []).some(message =>
  (Array.isArray(message.content) ? message.content : []).some(part =>
    part.type === "tool" && !["completed", "error", "failed", "cancelled", "canceled"].includes(part.state?.status)))
const callEvidence = (messages, callID) => (Array.isArray(messages) ? messages : [])
  .filter(message => message.type === "assistant")
  .flatMap(message => (Array.isArray(message.content) ? message.content : [])
    .filter(part => part.type === "tool" && part.id === callID)
    .map(part => ({ part, message_id: message.id ?? null })))

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


  // No caller-supplied liveness claims: all proof fields originate from the
  // live OpenCode APIs. The same controller commit path writes all transitions.
  async function recoverOrphan(input) {
    const execution = id(input.execution_id)
    // Authority is verified before even opening a controller or reading runtime
    // liveness. No caller can supply a boolean "approved" or forge a target.
    const authority = await findApprovedDispatchAbandonment(projectRoot, input.decision_artifact_id)
    if (authority.execution_id !== execution || authority.dispatch_id !== input.dispatch_id) {
      throw new Error("ORPHAN_AUTHORITY_MISMATCH: decision does not authorize this execution/dispatch")
    }
    return exclusive(execution, async () => {
      const controller = await createExecutionController({ dir: join(projectRoot, ".harness", "execution", "controller", execution) })
      let snap = await controller.snapshot()
      let d = snap.state.dispatches[input.dispatch_id]
      if (!d) throw new Error("Unknown dispatch")
      const stop = (reason, status = "EVIDENCE_INSUFFICIENT") => ({
        status, reason, execution_id: execution, dispatch_id: input.dispatch_id,
        safe_to_relaunch: false, next_action: "Hold dispatch and reservation; do not record_finish or launch a replacement."
      })
      if (snap.state.mandate?.authority_kind !== "OWNER_APPROVED_EPIC" ||
          !snap.state.wu || snap.state.wu.completed ||
          snap.state.wu.wu_id !== authority.wu_id ||
          d.wu_id !== authority.wu_id || d.session_id !== authority.child_session_id) {
        return stop("Approved decision must bind the active WU and exact child session", "ORPHAN_AUTHORITY_MISMATCH")
      }
      const approval = { source_artifact_id: authority.source_artifact_id,
        source_record_key: authority.source_record_key, source_hash: authority.source_hash }
      if (!input.session_id || !["launched", "abandoned", "abandoned_reconciled"].includes(d.status) ||
          !d.session_id || !d.launch_call_id || !d.claim_required || !d.prepared_by_session_id ||
          !d.expected_agent || !d.wu_id) return stop("Exact claimed, launched child identity required")
      if (d.status === "abandoned_reconciled") return { status: "ALREADY_RECONCILED",
        child_session_id: d.session_id, charged_seconds: d.actual_consumption,
        classification: "ABANDONED_NOT_SUCCESS", safe_to_relaunch: true }
      if (typeof ctx.session?.get !== "function" || typeof ctx.session.context !== "function" ||
          typeof ctx.session.wait !== "function" || typeof ctx.session.interrupt !== "function") {
        return stop("OpenCode get/context/wait/interrupt are all required", "CAPABILITY_UNAVAILABLE")
      }
      let caller
      try { caller = unwrap(await readRuntime(() => ctx.session.get({ sessionID: input.session_id }))) }
      catch { return stop("Cannot verify root caller", "CAPABILITY_UNAVAILABLE") }
      if (caller?.id !== input.session_id || caller.parentID || caller.agent !== "harness-orchestrator")
        return stop("Only the actual root orchestrator may recover an orphan", "IDENTITY_CONFLICT")
      if (!d.fence && d.status !== "launched") return stop("Unfenced abandonment is invalid", "EVIDENCE_CONFLICT")
      const childID = d.session_id, parentID = d.prepared_by_session_id
      const loadChild = async () => {
        const [child, childContext, parentContext] = await Promise.all([
          readRuntime(() => ctx.session.get({ sessionID: childID })),
          readRuntime(() => ctx.session.context({ sessionID: childID })),
          readRuntime(() => ctx.session.context({ sessionID: parentID })),
        ])
        return { child: unwrap(child), childContext: unwrap(childContext), parentContext: unwrap(parentContext) }
      }
      const valid = evidence => {
        const { child, childContext, parentContext } = evidence
        if (child?.id !== childID || child.parentID !== parentID || child.agent !== d.expected_agent ||
            !child.projectID || !caller.projectID || child.projectID !== caller.projectID ||
            !Array.isArray(childContext) || !Array.isArray(parentContext)) return false
        const matches = callEvidence(parentContext, d.launch_call_id)
        if (matches.length !== 1) return false
        const call = matches[0].part
        return call.name === "subagent" && call.state?.input?.agent === d.expected_agent &&
          call.state?.metadata?.sessionID === childID &&
          call.state?.status !== "completed" && call.state?.metadata?.status !== "completed" &&
          child.outcome !== "succeeded" && !unresolvedTools(childContext)
      }
      async function idle() {
        try { await readRuntime(() => ctx.session.wait({ sessionID: childID })); return true }
        catch { return false }
      }
      let first
      try { first = await loadChild() } catch { return stop("Cannot inspect child and exact parent call", "CAPABILITY_UNAVAILABLE") }
      if (!valid(first)) return stop("Child/parent/project identity conflicts, context incomplete, tool unsettled, or terminal success exists", "EVIDENCE_CONFLICT")
      // A wait timeout is UNKNOWN, never permission to interrupt a live tool.
      if (!(await idle())) return stop("Child is active or cannot be proven quiescent", "CHILD_ACTIVITY_UNKNOWN")
      let second
      try { second = await loadChild() } catch { return stop("Second independent session read failed", "CAPABILITY_UNAVAILABLE") }
      if (!valid(second) || stableHash(first) !== stableHash(second))
        return stop("Session or parent call changed across fresh idle observations", "SNAPSHOT_CHANGED")
      if (!d.fence) {
        // An acknowledged interrupt prevents queued continuation during the
        // fence window. The tool hooks independently refuse all future mutations.
        try { await readRuntime(() => ctx.session.interrupt({ sessionID: childID, continue: false })) }
        catch { return stop("Cannot interrupt child before durable fencing", "CAPABILITY_UNAVAILABLE") }
        if (!(await idle())) return stop("Child not quiescent after interruption", "CHILD_ACTIVITY_UNKNOWN")
        const before = await controller.snapshot()
        const current = before.state.dispatches[input.dispatch_id]
        if (before.state.revision !== snap.state.revision || current.status !== "launched" ||
            current.session_id !== childID) return stop("Controller changed during pre-fence observation", "SNAPSHOT_CHANGED")
        const proof = { kind: "VERIFIED_QUIESCENT_CHILD", child_session_id: childID,
          parent_session_id: parentID, launch_call_id: d.launch_call_id, agent: d.expected_agent,
          runtime_quiescent: true, pending_tools: 0, interrupted: true,
          fence_hook_installed: true, observation_hash: stableHash([first, second]),
          approved_abandonment: approval }
        const lease = await controller.acquire(input.session_id)
        try { await controller.commit({
          operation_id: `${execution}:orphan-fence:${input.dispatch_id}:${childID}`,
          operation_type: "DISPATCH_FENCE", body: { dispatch_id: input.dispatch_id, expected_revision: before.state.revision,
            child_session_id: childID, parent_session_id: parentID, launch_call_id: d.launch_call_id,
            agent: d.expected_agent, wu_id: d.wu_id, proof },
        }, { holder_session_id: input.session_id, expected_revision: before.state.revision, lease_fencing_token: lease.fencing_token }) }
        catch (error) { return stop(`Fence rejected: ${error.message}`, "SNAPSHOT_CHANGED") }
      }
      // Fence exists durably before post-fence observation or settlement.
      snap = await controller.snapshot()
      d = snap.state.dispatches[input.dispatch_id]
      if (!d.fence || d.fence.child_session_id !== childID) return stop("Missing durable fence", "EVIDENCE_CONFLICT")
      try { await readRuntime(() => ctx.session.interrupt({ sessionID: childID, continue: false })) }
      catch { return stop("Post-fence interruption not acknowledged", "CAPABILITY_UNAVAILABLE") }
      if (!(await idle())) return stop("Post-fence session is still active", "CHILD_ACTIVITY_UNKNOWN")
      let after
      try { after = await loadChild() } catch { return stop("Cannot read post-fence session", "CAPABILITY_UNAVAILABLE") }
      if (!valid(after)) return stop("Post-fence child identity or tool liveness changed", "EVIDENCE_CONFLICT")
      if (d.status === "launched") {
        const lease = await controller.acquire(input.session_id)
        const observed = await controller.snapshot()
        if (observed.state.revision !== snap.state.revision) return stop("Controller changed after fence", "SNAPSHOT_CHANGED")
        await controller.commit({
          operation_id: `${execution}:orphan-abandon:${input.dispatch_id}:${childID}`,
          operation_type: "DISPATCH_ABANDON", body: { dispatch_id: input.dispatch_id, child_session_id: childID,
            fence_generation: d.fence.generation, proof: {
              kind: "POST_FENCE_QUIESCENCE", child_session_id: childID,
              runtime_quiescent: true, pending_tools: 0, fence_enforced: true,
              observation_hash: stableHash(after), approved_abandonment: approval } },
        }, { holder_session_id: input.session_id, expected_revision: observed.state.revision, lease_fencing_token: lease.fencing_token })
        snap = await controller.snapshot()
        d = snap.state.dispatches[input.dispatch_id]
      }
      if (d.status !== "abandoned") return stop("Abandonment state changed", "SNAPSHOT_CHANGED")
      const lease = await controller.acquire(input.session_id)
      const observed = await controller.snapshot()
      if (observed.state.dispatches[input.dispatch_id].status !== "abandoned")
        return stop("Dispatch no longer awaiting settlement", "SNAPSHOT_CHANGED")
      const settled = await controller.commit({
        operation_id: `${execution}:orphan-settle:${input.dispatch_id}:${childID}`,
        operation_type: "DISPATCH_RECONCILE_ABANDONED",
        body: { dispatch_id: input.dispatch_id, fence_generation: d.fence.generation },
      }, { holder_session_id: input.session_id, expected_revision: observed.state.revision, lease_fencing_token: lease.fencing_token })
      return { status: "ABANDONED_RECONCILED", classification: "ABANDONED_NOT_SUCCESS",
        child_session_id: childID, charged_seconds: settled.state.dispatches[input.dispatch_id].actual_consumption,
        safe_to_relaunch: true, blocker: settled.state.blocker, approved_abandonment: approval,
        next_action: "Clear ONLY the independently resolved tooling blocker; reuse the existing WU and protect partial files." }
    })
  }

  return {
    recover,
    recoverOrphan,
    reset() { cached.clear() },
    track(binding) { launches.set(key(binding.session_id, binding.call_id), { ...binding, monotonic_started: performance.now() }) },
    async onProgress(event) {
      const binding = launches.get(key(event.sessionID, event.id))
      if (event.tool !== "subagent" || !binding || !event.metadata?.sessionID) return
      return recover(binding, { ...event, source: "tool.progress", message_id: event.messageID ?? null })
    },
    async afterTool(event) {
      if (event.tool !== "subagent") return
      const k = key(event.sessionID, event.id)
      const binding = launches.get(k)
      if (!binding) return
      try {
        // Error events may not retain progress metadata. Read the exact call's
        // persisted progress through context instead of parsing error prose.
        const result = await recover(binding, event.status === "completed" && event.result?.metadata?.sessionID ? {
          tool: event.tool, sessionID: event.sessionID, id: event.id, input: event.input,
          metadata: event.result?.metadata, source: "execute.after", message_id: event.messageID ?? null,
        } : undefined)
        if (event.status === "completed" && event.result?.metadata?.status === "completed" && result?.child_session_id) {
          const controller = await createExecutionController({ dir: join(projectRoot, ".harness/execution/controller", id(binding.execution_id)) })
          const lease = await controller.acquire(binding.session_id)
          let snap = await controller.snapshot()
          const d = snap.state.dispatches[binding.dispatch_id]
          if (!d.handoff) {
            const raw = event.result.content
            const text = typeof raw === "string" ? raw : (Array.isArray(raw) ? raw.filter(p => p.type === "text").map(p => p.text).join("\n") : "")
            await controller.commit({ operation_id: `${binding.execution_id}:handoff:${binding.dispatch_id}`, operation_type: "DISPATCH_HANDOFF",
              body: { dispatch_id: binding.dispatch_id, session_id: d.session_id, call_id: binding.call_id,
                content: text.slice(0, 16000), content_hash: stableHash(text), truncated: text.length > 16000 } },
              { holder_session_id: binding.session_id, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token })
            snap = await controller.snapshot()
          }
          if (!d.usage && d.status === "launched") await controller.commit({
            operation_id: `${binding.execution_id}:runtime-usage:${binding.dispatch_id}`,
            operation_type: "DISPATCH_USAGE", body: { dispatch_id: binding.dispatch_id, session_id: d.session_id,
              call_id: binding.call_id, source: "runtime.monotonic_dispatch_envelope", seconds: Math.ceil((performance.now() - binding.monotonic_started) / 1000) },
          }, { holder_session_id: binding.session_id, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token })
        }
        return result
      } finally { launches.delete(k) }
    },
  }
}
