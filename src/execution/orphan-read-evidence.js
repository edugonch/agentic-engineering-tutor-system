// Conservative classification for interrupted OpenCode subagent reads.
//
// An interrupted child may retain stale "running" tool entries. Only the
// native read tool or a narrowly recognized, literal stdout-only grep shell
// command is eligible. No textual tool output or description grants safety.
// All candidates still require owner approval, independent quiescence,
// acknowledged interruption, durable fencing and post-fence observation.
import { stableHash } from "./serialize.js"

const TERMINAL = new Set(["completed", "error", "failed", "cancelled", "canceled"])
const STALE_READ_STATES = new Set(["running", "pending"])
const SHELL_NAMES = new Set(["bash", "shell", "shell_command"])

// This is deliberately NOT a general-purpose shell-command parser. Only a
// simple literal 'grep -n ...' is allowed. Reject all shell control operators,
// substitutions, expansions, escapes, redirection, pipes and newlines. If a
// legitimate grep uses any other shell syntax, the recovery fails closed.
export function isLiteralReadOnlyGrep(value) {
  if (typeof value !== "string" || value.length > 4096) return false
  const command = value.trim()
  if (!/^grep[ \t]+-n[ \t]+\S/.test(command)) return false
  if (/[;&|<>\x60$\\(){}\n\r\0!#]/.test(command)) return false
  if (!/^[A-Za-z0-9_./*?\[\]:='",+\- \t]+$/.test(command)) return false
  // Do not treat quoted or inexact shell prefixes as the grep executable.
  return true
}

function safeShellInput(part) {
  if (!SHELL_NAMES.has(part.name)) return null
  const input = part.state?.input
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const command = typeof input.command === "string" ? input.command : input.cmd
  if (typeof input.command === "string" && typeof input.cmd === "string" && input.command !== input.cmd) return null
  if (!isLiteralReadOnlyGrep(command)) return null
  return stableHash({ command, cwd: input.workdir ?? input.cwd ?? null })
}

export function unsettledToolParts(messages) {
  if (!Array.isArray(messages)) return null
  return messages.flatMap(message => Array.isArray(message?.content)
    ? message.content.filter(part => part?.type === "tool" && !TERMINAL.has(part.state?.status))
    : [])
}

export function classifyOrphanReadTools(messages) {
  const parts = unsettledToolParts(messages)
  if (!parts) return { eligible: false, reason: "Unsupported child context", reason_code: "CHILD_CONTEXT_UNAVAILABLE" }
  if (parts.length === 0) return { eligible: true, ids: [], pending_tools: 0 }
  if (parts.length > 16) return { eligible: false, reason: "More than 16 unfinished tools", reason_code: "TOO_MANY_UNFINISHED_TOOLS" }

  const shell_commands = []
  const ids = new Set()
  for (const part of parts) {
    const detail = { call_id: typeof part.id === "string" ? part.id : null,
      tool_name: typeof part.name === "string" ? part.name : null,
      tool_status: part.state?.status ?? null }
    const reject = (reason_code, reason) => ({ eligible: false, reason_code, reason, rejected_tool: detail })
    if (!STALE_READ_STATES.has(part.state?.status)) return reject("UNKNOWN_TOOL_STATE", "Unfinished tool has an unsupported runtime state")
    if (typeof part.id !== "string" || !part.id.trim()) return reject("MISSING_TOOL_ID", "Unfinished tool has no stable call ID")
    if (ids.has(part.id)) return reject("DUPLICATE_TOOL_ID", "Duplicate unfinished tool call ID")
    ids.add(part.id)
    if (part.name === "read") continue
    if (!SHELL_NAMES.has(part.name)) return reject("UNTRUSTED_TOOL_NAME", "Unfinished tool name is not a supported read-only shell adapter")
    const input = part.state?.input
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return reject("SHELL_INPUT_UNAVAILABLE", "Shell command input is absent or invalid")
    }
    detail.input_keys = Object.keys(input).sort().slice(0, 12)
    const command = typeof input.command === "string" ? input.command : input.cmd
    if (typeof command !== "string") return reject("SHELL_COMMAND_UNAVAILABLE", "No literal command/cmd input is present")
    if (!isLiteralReadOnlyGrep(command)) return reject("SHELL_COMMAND_NOT_LITERAL_GREP", "Shell input does not match the restricted literal grep -n grammar")
    const commandHash = safeShellInput(part)
    if (!commandHash) return reject("SHELL_COMMAND_CONFLICT", "Shell input fields conflict or cannot be hashed")
    shell_commands.push({ id: part.id, command_hash: commandHash })
  }
  const result = { eligible: true, ids: [...ids].sort(), pending_tools: ids.size }
  if (shell_commands.length) result.shell_commands = shell_commands.sort((a, b) => a.id.localeCompare(b.id))
  return result
}

// A tool with the same ID cannot silently change its command after interrupt.
// All new unfinished tools are refused, even if they are read-only.
export function pendingReadsNotExpanded(before, after) {
  if (!before?.eligible || !after?.eligible || !after.ids.every(id => before.ids.includes(id))) return false
  const original = new Map((before.shell_commands ?? []).map(item => [item.id, item.command_hash]))
  const later = new Map((after.shell_commands ?? []).map(item => [item.id, item.command_hash]))
  return [...later].every(([id, hash]) => original.get(id) === hash) &&
    [...original.keys()].every(id => !after.ids.includes(id) || later.has(id))
}

// Replay validation for an auditable interrupted read-only proof. Old proofs
// containing only native 'read' tools retain their previous accepted shape.
export function validOrphanPendingProof(proof) {
  if (!Number.isSafeInteger(proof?.pending_tools) || proof.pending_tools < 0) return false
  if (proof.pending_tools === 0) return true
  const ids = proof.unsettled_read_only_tools
  if (proof.interrupted_read_only !== true ||
      !Array.isArray(ids) || ids.length !== proof.pending_tools ||
      ids.length > 16 || ids.some(id => typeof id !== "string" || !id.trim()) ||
      new Set(ids).size !== ids.length) return false
  if (proof.shell_commands === undefined) return true
  const entries = proof.shell_commands
  return Array.isArray(entries) && entries.length > 0 && entries.length <= ids.length &&
    new Set(entries.map(item => item?.id)).size === entries.length &&
    entries.every(item => ids.includes(item?.id) && /^[a-f0-9]{64}$/.test(item?.command_hash ?? ""))
}
