// OpenCode V2 2.0.24: tool execute.before exposes the originating agent;
// session.switchAgent affects subsequent provider turns, not pending tool calls.
export const ORCHESTRATOR = "harness-orchestrator"
const SPECIALISTS = new Set(["harness-builder", "harness-designer", "harness-reviewer", "harness-researcher"])
const READ_TOOLS = new Set([
  "harness_analyze_existing_project", "harness_discover_project_knowledge",
  "harness_search_project_knowledge", "harness_read_project_knowledge",
  "harness_project_status", "harness_check_agent_readiness", "harness_validate_story",
  "harness_search_knowledge", "harness_check_execution_readiness",
])
const READ_ACTIONS = new Set(["status", "verify", "recover"])

function fail(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

export function specialistMayUse(agent, tool, input = {}) {
  if (!SPECIALISTS.has(agent)) return false
  if (READ_TOOLS.has(tool)) return true
  if (tool === "harness_execution_controller") return READ_ACTIONS.has(input.action)
  if (tool === "harness_run_verification") return agent !== "harness-researcher"
  if (tool === "harness_freeze_candidate") return agent === "harness-builder" || agent === "harness-designer"
  return false
}

export function createOrchestratorOwnership(ctx) {
  const transfers = new Map()
  const unwrap = value => value?.data ?? value
  async function session(sessionID) {
    if (!sessionID || typeof ctx.session?.get !== "function") throw fail("HARNESS_IDENTITY_UNKNOWN", "Runtime session identity is required.")
    const info = unwrap(await ctx.session.get({ sessionID }))
    if (!info || info.id !== sessionID || typeof info.agent !== "string") throw fail("HARNESS_IDENTITY_UNKNOWN", "Runtime returned an unverifiable session.")
    return info
  }
  async function ready() {
    const profile = unwrap(await ctx.agent.get({ agentID: ORCHESTRATOR }))
    if (!profile || profile.disabled || !["primary", "all"].includes(profile.mode)) {
      throw fail("HARNESS_ORCHESTRATOR_UNAVAILABLE", "The loaded orchestrator must be enabled and primary; reload the corrected plugin/profile.")
    }
  }
  async function takeOwnership(sessionID) {
    if (transfers.has(sessionID)) return transfers.get(sessionID)
    const pending = (async () => {
      const before = await session(sessionID)
      if (before.parentID) throw fail("HARNESS_ROLE_DENIED", "A specialist child session cannot become the primary orchestrator.")
      await ready()
      if (before.agent !== ORCHESTRATOR) {
        if (typeof ctx.session.switchAgent !== "function") throw fail("HARNESS_SWITCH_UNAVAILABLE", "This runtime cannot switch session agents.")
        await ctx.session.switchAgent({ sessionID, agent: ORCHESTRATOR })
      }
      const after = await session(sessionID)
      if (after.agent !== ORCHESTRATOR || after.parentID) throw fail("HARNESS_HANDOFF_FAILED", "The runtime did not confirm the primary orchestrator.")
      await ctx.storage.set(`harness-owner:${sessionID}`, { agent: ORCHESTRATOR })
      return { changed: before.agent !== ORCHESTRATOR, sessionID, agent: ORCHESTRATOR }
    })()
    transfers.set(sessionID, pending)
    try { return await pending } finally { transfers.delete(sessionID) }
  }
  async function beforeTool(event) {
    const harnessDelegation = ["subagent", "task"].includes(event.tool) && String(event.input?.agent ?? event.input?.subagent_type ?? "").startsWith("harness-")
    if (!event.tool?.startsWith("harness_") && !harnessDelegation) {
      // Also stop shell/edit calls already queued by build after takeover.
      // This cannot undo side effects that started before the handoff boundary.
      if (!await ctx.storage.get(`harness-owner:${event.sessionID}`)) return
      const current = await session(event.sessionID)
      if (current.parentID || !event.agent) throw fail("HARNESS_IDENTITY_UNKNOWN", "Owned root call has no verifiable origin.")
      if (event.agent !== ORCHESTRATOR || current.agent !== ORCHESTRATOR) {
        await takeOwnership(event.sessionID)
        throw fail("HARNESS_HANDOFF_REQUIRED", "Previous-agent call was not executed; continue with the primary orchestrator.")
      }
      return
    }
    // Never accept input.session_id or the newly selected session agent as the
    // identity of an already emitted tool call.
    if (!event.agent || !event.sessionID) throw fail("HARNESS_IDENTITY_UNKNOWN", "Tool origin was not supplied by OpenCode.")
    const info = await session(event.sessionID)
    if (event.agent === ORCHESTRATOR) {
      if (info.parentID || info.agent !== ORCHESTRATOR) throw fail("HARNESS_ROLE_DENIED", "Orchestrator must own the current root session.")
      await ready()
      if (event.input?.session_id && event.input.session_id !== event.sessionID) {
        throw fail("HARNESS_SESSION_MISMATCH", "A tool argument cannot impersonate another lease holder.")
      }
      await ctx.storage.set(`harness-owner:${event.sessionID}`, { agent: ORCHESTRATOR })
      // Mutating lease holder identity always comes from the runtime.
      if (["harness_execution_controller", "harness_continuation_probe"].includes(event.tool)) {
        event.input = { ...event.input, session_id: event.sessionID }
      }
      return
    }
    if (SPECIALISTS.has(event.agent)) {
      if (!info.parentID || info.agent !== event.agent) throw fail("HARNESS_ROLE_DENIED", "Specialist requires its actual child session.")
      const parent = await session(info.parentID)
      if (parent.parentID || parent.agent !== ORCHESTRATOR || !specialistMayUse(event.agent, event.tool, event.input)) {
        throw fail("HARNESS_ROLE_DENIED", "This specialist may not execute the requested governance operation; return it to the primary orchestrator.")
      }
      return
    }
    if (info.parentID) throw fail("HARNESS_ROLE_DENIED", "An unrelated child agent cannot take ownership.")
    await takeOwnership(event.sessionID)
    throw fail("HARNESS_HANDOFF_REQUIRED", "Session transferred to harness-orchestrator. This call from the previous agent was NOT executed. Continue on the next provider turn, inspect durable state, and decide the next authorized action. Do not replay the old mutation automatically.")
  }
  async function onPrompt(event) {
    if (await ctx.storage.get(`harness-owner:${event.sessionID}`)) await takeOwnership(event.sessionID)
  }
  return { takeOwnership, beforeTool, onPrompt }
}
