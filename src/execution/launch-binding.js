// Ephemeral, in-memory launch-binding registry (Wave B hardening).
//
// Maps a controller session + the agent it prepared to launch, to the exact
// execution_id + dispatch_id the next subagent launch should claim. It is
// single-use and process-local: it is never a durable authority source.
//
//   - set():     registers a binding; REJECTS a second prepare for the same key
//                (a pending binding must be consumed or cleared first — no
//                silent overwrite that would strand an already-prepared dispatch).
//   - consume(): atomically removes and returns the binding exactly once, so a
//                stale binding never re-claims a previously-launched dispatch.
//   - peek():    read-only lookup (diagnostics/tests).
//
// If the process dies after prepare_launch but before the subagent, the registry
// is lost and the durable dispatch remains unclaimed (releasable). The durable
// log — not this registry — decides NEVER_LAUNCHED vs AMBIGUOUS.

function key(sessionID, agent) {
  return `${sessionID}::${agent}`
}

export function createLaunchBindingRegistry() {
  const bindings = new Map()

  return {
    set(sessionID, agent, binding) {
      const k = key(sessionID, agent)
      if (bindings.has(k)) {
        throw new Error(`A launch binding is already pending for ${agent}; consume or clear it before preparing another launch.`)
      }
      bindings.set(k, binding)
    },
    consume(sessionID, agent) {
      const k = key(sessionID, agent)
      const binding = bindings.get(k)
      if (binding !== undefined) bindings.delete(k)
      return binding
    },
    peek(sessionID, agent) {
      return bindings.get(key(sessionID, agent))
    },
    release(executionID, dispatchID) {
      for (const [k, binding] of bindings) {
        if (binding.execution_id === executionID && binding.dispatch_id === dispatchID) bindings.delete(k)
      }
    },
    clear() {
      bindings.clear()
    },
    size() {
      return bindings.size
    },
  }
}

// Restart recovery: reconstruct the ephemeral lookup from durable preparation.
export async function findPendingLaunchBinding(projectRoot, sessionID, agent) {
  const { readdir } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const { createExecutionController } = await import("./execution.js")
  const root = join(projectRoot, ".harness/execution/controller")
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) }
  catch (error) { if (error.code === "ENOENT") return null; throw error }
  const matches = []
  for (const entry of entries.filter(e => e.isDirectory())) {
    const c = await createExecutionController({ dir: join(root, entry.name) })
    const { state } = await c.snapshot()
    if (state.completed) continue
    for (const [dispatch_id, d] of Object.entries(state.dispatches)) {
      if (d.prepared_by_session_id !== sessionID || d.expected_agent !== agent || d.status !== "pending_launch") continue
      if (d.launch_call_id) throw new Error("HARNESS_UNRESOLVED_LAUNCH: recover the claimed dispatch before another launch")
      matches.push({ execution_id: entry.name, dispatch_id })
    }
  }
  if (matches.length > 1) throw new Error("Multiple pending launch bindings; resolve the exact dispatch before launching")
  return matches[0] ?? null
}
