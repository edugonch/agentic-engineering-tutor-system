import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
export const defaultContract = { commands: [{ id: "check-1", program: "node", args: ["-e", "process.exit(0)"] }], environment: { network_policy: "UNRESTRICTED" } }
export async function seedWuContract(root, wu = "WU-01", epic = "epic-001", seconds = 100, verification = defaultContract) {
  return recordKnowledgeArtifact(root, { artifact_type: "work-unit", artifact_id: wu, title: wu,
    status: "PROPOSED", owner_confirmed: true, parent_refs: [epic],
    content: `Active-time limit: ${seconds} seconds\nexecution_contract: ${JSON.stringify({ active_seconds: seconds, verification_contract: verification, process_obligations: [] })}` })
}
