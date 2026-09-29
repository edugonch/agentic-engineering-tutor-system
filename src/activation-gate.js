import { checkWorkUnitAgentReadiness, isApprovedWorkUnitActivation } from "./agent-readiness.js"

export async function recordArtifactWithActivationGate(projectRoot, input, agentApi, recordArtifact) {
  if (isApprovedWorkUnitActivation(input)) {
    const readiness = await checkWorkUnitAgentReadiness(agentApi)
    if (!readiness.ready) {
      return {
        status: "blocked",
        artifact_id: input.artifact_id,
        reason: "Work Unit activation decisions cannot be recorded until the required specialist roles are available in OpenCode's runtime registry.",
        work_unit_agent_readiness: readiness,
        files_written: [],
      }
    }
  }
  return recordArtifact(projectRoot, input)
}
