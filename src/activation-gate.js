import { checkWorkUnitAgentReadiness, isApprovedWorkUnitActivation } from "./agent-readiness.js"

export async function recordArtifactWithActivationGate(projectRoot, input, agentApi, recordArtifact) {
  // Exact file-backed decisions can contain activation authority unavailable in
  // input.content. Keep the existing readiness gate conservatively, without a
  // second source read or a content override that could change approved bytes.
  const exactDecision = input?.artifact_type === "decision" && input.status === "APPROVED"
    && (input.content_source_path !== undefined || input.expected_content_sha256 !== undefined)
  if (exactDecision || isApprovedWorkUnitActivation(input)) {
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
