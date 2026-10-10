const REQUIRED_WORK_UNIT_AGENTS = Object.freeze([
  { id: "harness-builder", purpose: "implement the activated Work Unit" },
  { id: "harness-reviewer", purpose: "independently review the Work Unit" },
])

export function isApprovedWorkUnitActivation(input) {
  if (input?.artifact_type !== "decision" || input?.status !== "APPROVED") return false
  const identity = `${input.artifact_id ?? ""}\n${input.title ?? ""}`
  if (!/\bWU[-_ ]?\d+\b/i.test(identity) || !/\b(?:activation|activate|activating|activated|activaci[oó]n|activar|activado|activada)\b/i.test(identity)) return false
  const content = String(input.content ?? "")
  return /\bWU[-_ ]?\d+\s*[:=–-]\s*(?:ACTIVE|ACTIVATED|ACTIVADA|ACTIVADO)\b/i.test(content)
    || /\b(?:activate|activating|activated|activada|activado|activar|activaci[oó]n)\s+(?:WU[-_ ]?\d+|work unit|unidad de trabajo)\b/i.test(content)
}

function agentRecords(response) {
  if (Array.isArray(response)) return response
  if (Array.isArray(response?.data)) return response.data
  if (Array.isArray(response?.agents)) return response.agents
  return null
}

function agentId(agent) {
  return agent?.name ?? agent?.id ?? agent?.agentID ?? agent?.identifier ?? null
}

export function assessWorkUnitAgentReadiness(response) {
  const records = agentRecords(response)
  if (!records) {
    return {
      status: "unknown",
      ready: false,
      required: REQUIRED_WORK_UNIT_AGENTS,
      available: [],
      missing: REQUIRED_WORK_UNIT_AGENTS.map((agent) => agent.id),
      blocker: "OpenCode returned no recognizable agent inventory; do not activate or delegate the Work Unit.",
    }
  }

  const byId = new Map(records.map((agent) => [agentId(agent), agent]).filter(([id]) => id))
  const available = []
  const missing = []
  const wrongMode = []

  for (const required of REQUIRED_WORK_UNIT_AGENTS) {
    const agent = byId.get(required.id)
    // OpenCode's `hidden` flag only removes an agent from user-facing
    // autocomplete; hidden agents remain callable by an allowed subagent
    // invocation. Only a disabled or absent registry entry is unavailable.
    if (!agent || agent.disabled === true) {
      missing.push(required.id)
      continue
    }
    if (agent.mode && agent.mode !== "subagent" && agent.mode !== "all") {
      wrongMode.push({ id: required.id, mode: agent.mode })
      continue
    }
    available.push({ id: required.id, mode: agent.mode ?? "unreported", purpose: required.purpose })
  }

  const ready = missing.length === 0 && wrongMode.length === 0
  return {
    status: ready ? "ready" : "blocked",
    ready,
    required: REQUIRED_WORK_UNIT_AGENTS,
    available,
    missing,
    wrong_mode: wrongMode,
    blocker: ready
      ? null
      : "Required Harness specialists are unavailable or cannot run as subagents. Keep the Work Unit unactivated and do not delegate until readiness is verified.",
  }
}

export async function checkWorkUnitAgentReadiness(agentApi) {
  if (!agentApi || typeof agentApi.list !== "function") {
    return {
      status: "unknown",
      ready: false,
      required: REQUIRED_WORK_UNIT_AGENTS,
      available: [],
      missing: REQUIRED_WORK_UNIT_AGENTS.map((agent) => agent.id),
      blocker: "OpenCode's agent registry API is unavailable; do not activate or delegate the Work Unit.",
    }
  }

  try {
    return {
      ...assessWorkUnitAgentReadiness(await agentApi.list()),
      orchestrator_terminal: await inspectOrchestratorTerminal(agentApi),
    }
  } catch (error) {
    return {
      status: "unknown",
      ready: false,
      required: REQUIRED_WORK_UNIT_AGENTS,
      available: [],
      missing: REQUIRED_WORK_UNIT_AGENTS.map((agent) => agent.id),
      blocker: `OpenCode agent inventory failed (${error?.message ?? "unknown error"}); do not activate or delegate the Work Unit.`,
    }
  }
}

export async function guardHarnessSubagentPermission(event, agentApi) {
  if (event?.action !== "subagent") return { blocked: false }
  const requested = new Set((Array.isArray(event.resources) ? event.resources : []).map(String))
  if (![...requested].some((id) => REQUIRED_WORK_UNIT_AGENTS.some((role) => role.id === id))) {
    return { blocked: false }
  }

  const readiness = await checkWorkUnitAgentReadiness(agentApi)
  if (readiness.ready) return { blocked: false, readiness }

  event.effect = "deny"
  event.message = readiness.blocker
  return { blocked: true, readiness }
}

/** Report configured rules, not a claim about effective session permissions. */
export async function inspectOrchestratorTerminal(agentApi) {
  try {
    const response = await agentApi.get({ agentID: "harness-orchestrator" })
    const agent = response?.data ?? response
    if ((agent?.id ?? agent?.name) !== "harness-orchestrator" || !Array.isArray(agent.permissions)) {
      throw new Error("Loaded orchestrator permissions unavailable")
    }
    const rules = agent.permissions.filter(rule => rule.action === "shell" || rule.action === "*")
    return {
      status: "profile_rules_observed",
      rules,
      has_shell_deny: rules.some(rule => rule.effect === "deny"),
      session_access: "unverified",
      note: "Profile rules only. Verify terminal exposure and the required CLI read in the actual session; project/session policies and credentials may differ.",
    }
  } catch (error) {
    return { status: "unknown", session_access: "unverified", note: error?.message ?? "Cannot inspect terminal permissions" }
  }
}

// Conservative static preflight: do not override native session evaluation or
// grant permissions. A matching deny is actionable; absence is not proof of
// remote credentials or a session-specific allow.
export function configuredToolDenial(agent, tool) {
  const match = (pattern, value) => typeof pattern === "string" && new RegExp(`^${pattern.split("*").map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value)
  return (agent?.permissions ?? []).some(rule => rule.effect === "deny" &&
    (match(rule.action, tool) || (rule.action === "tool" && match(rule.resource, tool))))
}
