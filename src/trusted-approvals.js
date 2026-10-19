import { stableHash } from "./execution/serialize.js"
const messageText = m => typeof m.content === "string" ? m.content : Array.isArray(m.content)
  ? m.content.filter(p => p.type === "text" && typeof p.text === "string").map(p => p.text).join("\n") : ""
export const exactApprovalHash = input => stableHash({
  artifact_type: input.artifact_type, artifact_id: input.artifact_id,
  title: input.title, content: input.content, status: input.status,
  source_refs: input.source_refs ?? [], parent_refs: input.parent_refs ?? [],
})
export function findTrustedApproval(messages, sessionID, input) {
  if (!Array.isArray(messages)) return null
  const hash = exactApprovalHash(input)
  const exact = "APPROVE_HARNESS_ARTIFACT " + input.artifact_id + " " + hash
  const user = messages.filter(m => m?.type === "user" && typeof m.id === "string" &&
    messageText(m).trim() === exact).at(-1)
  return user ? { channel: "opencode_runtime_user_message", session_id: sessionID,
    user_message_id: user.id, artifact_id: input.artifact_id, artifact_hash: hash } : null
}
export function assertTrustedApproval(input, attestation) {
  if (input.status !== "APPROVED") return
  if (!attestation || attestation.channel !== "opencode_runtime_user_message" ||
      !attestation.session_id || !attestation.user_message_id ||
      attestation.artifact_id !== input.artifact_id ||
      attestation.artifact_hash !== exactApprovalHash(input)) {
    const error = new Error("TRUSTED_APPROVAL_REQUIRED: the owner must send an exact user message: APPROVE_HARNESS_ARTIFACT " + input.artifact_id + " " + exactApprovalHash(input) + ". Until then record PROPOSED.")
    error.code = "TRUSTED_APPROVAL_REQUIRED"
    throw error
  }
}
