// Migrate the original Harness default after OpenCode merges global/project
// profiles. Never rewrite local configuration, prompts, models or permissions.
const ID = "harness-orchestrator"

export function readOrchestratorStepLimit(env = {}) {
  const value = env.HARNESS_ORCHESTRATOR_MAX_STEPS
  if (value === undefined || value === "") return null
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error("HARNESS_ORCHESTRATOR_MAX_STEPS must be a positive integer or unset.")
  }
  return Number(value)
}

export async function registerOrchestratorSteps(agentApi, env = {}) {
  const override = readOrchestratorStepLimit(env)
  await agentApi.transform(editor => {
    editor.update(ID, agent => {
      if (override !== null) agent.steps = override
      else if (agent.steps === 12) delete agent.steps
    })
  })
  return { override, migrated_legacy_default: 12 }
}

export async function inspectOrchestratorSteps(agentApi) {
  try {
    const response = await agentApi.get({ agentID: ID })
    const agent = response?.data ?? response
    if (!agent || (agent.id ?? agent.name) !== ID) throw new Error("Orchestrator profile not found")
    const steps = agent.steps ?? null
    return {
      status: steps === null ? "no_step_limit" : "configured_step_limit",
      effective_steps: steps,
      note: steps === null
        ? "No model-step cutoff is configured for the orchestrator. Governance and circuit breakers still apply."
        : "An effective model-step limit remains. OpenCode removes tools on its final step; this is not a WU budget.",
    }
  } catch (error) {
    return { status: "unknown", effective_steps: null, note: error?.message ?? "Cannot inspect the loaded orchestrator" }
  }
}
