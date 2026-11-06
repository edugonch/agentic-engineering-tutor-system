// Conservative classification for interrupted OpenCode subagent reads.
//
// Context may preserve "running" read entries after a session was interrupted.
// These entries cannot be treated as successful or terminal work. They are
// eligible for orphan fencing ONLY when the live runtime independently proves
// quiescence and acknowledges interrupt, with exact dispatch/parent/child
// identity and an owner-approved abandonment. Any unfinished non-read tool
// remains an absolute stop.
const TERMINAL = new Set(["completed", "error", "failed", "cancelled", "canceled"])
const STALE_READ_STATES = new Set(["running", "pending"])

export function unsettledToolParts(messages) {
  if (!Array.isArray(messages)) return null
  return messages.flatMap(message => Array.isArray(message?.content)
    ? message.content.filter(part => part?.type === "tool" && !TERMINAL.has(part.state?.status))
    : [])
}

export function classifyOrphanReadTools(messages) {
  const parts = unsettledToolParts(messages)
  if (!parts) return { eligible: false, reason: "Unsupported child context" }
  if (parts.length === 0) return { eligible: true, ids: [], pending_tools: 0 }
  if (parts.length > 16 || parts.some(part =>
    part.name !== "read" || !STALE_READ_STATES.has(part.state?.status) ||
    typeof part.id !== "string" || !part.id.trim())) {
    return { eligible: false, reason: "An unfinished non-read or unidentifiable tool is present" }
  }
  const ids = parts.map(part => part.id)
  if (new Set(ids).size !== ids.length) return { eligible: false, reason: "Duplicate unfinished tool identity" }
  return { eligible: true, ids: ids.sort(), pending_tools: ids.length }
}

// After the acknowledged interruption, unfinished reads must not proliferate.
// A prior read may settle, but a newly started read indicates active child work.
export function pendingReadsNotExpanded(before, after) {
  return before?.eligible && after?.eligible &&
    after.ids.every(id => before.ids.includes(id))
}

// Used by the append-only state projection to validate the new audited
// evidence shape; legacy zero-pending proofs retain their previous meaning.
export function validOrphanPendingProof(proof) {
  if (!Number.isSafeInteger(proof?.pending_tools) || proof.pending_tools < 0) return false
  if (proof.pending_tools === 0) return true
  const ids = proof.unsettled_read_only_tools
  return proof.interrupted_read_only === true &&
    Array.isArray(ids) && ids.length === proof.pending_tools &&
    ids.length <= 16 && ids.every(id => typeof id === "string" && id.trim()) &&
    new Set(ids).size === ids.length
}
