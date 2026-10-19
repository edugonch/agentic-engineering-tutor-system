// Non-normative observed usage data. Never changes a Work Unit ledger or approval.
// Store message IDs and numeric usage only; prompts, content and secrets are omitted.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

const validId = s => typeof s === "string" && /^[A-Za-z0-9._-]{1,200}$/.test(s) && s !== "." && s !== ".."
const integer = n => Number.isSafeInteger(n) && n >= 0 ? n : null

export function extractRuntimeUsage(event) {
  if (event?.type !== "message.updated") return null
  const info = event.properties?.info ?? event.properties?.message
  const tokens = info?.tokens
  if (!info?.id || !info.sessionID || !tokens || typeof tokens !== "object") return null
  const input = integer(tokens.input), output = integer(tokens.output)
  const cache_read = integer(tokens.cache?.read), cache_write = integer(tokens.cache?.write)
  if (input === null && output === null && cache_read === null && cache_write === null) return null
  return { message_id: info.id, session_id: info.sessionID, model: typeof info.modelID === "string" ? info.modelID : null,
    input, output, cache_read, cache_write }
}
export function summarizeUsage(records, wuId = null) {
  const data = Object.values(records).filter(x => !wuId || x.wu_id === wuId)
  const sum = k => {
    const known = data.map(x => x[k]).filter(x => x !== null && x !== undefined)
    return known.length ? known.reduce((a,b)=>a+b,0) : "unknown"
  }
  return { source: "OpenCode runtime (observed message.updated only)", message_count: data.length,
    tokens_input: sum("input"), tokens_output: sum("output"),
    tokens_cache_read: sum("cache_read"), tokens_cache_write: sum("cache_write"),
    estimated_cost: "unknown", unknown_cost_reason: "No operator-provided dated token pricing configuration",
    measured_usage_available: data.length > 0 }
}
export function createEfficiencyTelemetry(projectRoot, { enabled = false } = {}) {
  const root = join(projectRoot, ".harness", "execution", "telemetry")
  const association = new Map()
  const pathFor = id => join(root, id + ".json")
  async function load(id) {
    try { return JSON.parse(await readFile(pathFor(id), "utf8")) }
    catch (err) { if (err.code === "ENOENT") return { schema_version: 1, messages: {} }; throw err }
  }
  async function store(id, value) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const tmp = pathFor(id) + "." + randomUUID() + ".tmp"
    try { await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await rename(tmp, pathFor(id)) }
    finally { /* cleanup only if a failed move left a temporary file */ }
  }
  return {
    enabled,
    associate(sessionID, executionID, wuID, phase = "ORCHESTRATION") {
      if (enabled && validId(sessionID) && validId(executionID)) {
        association.set(sessionID, { execution_id: executionID, wu_id: wuID ?? null, phase })
      }
    },
    async onEvent(event) {
      if (!enabled) return
      const usage = extractRuntimeUsage(event)
      const link = usage && association.get(usage.session_id)
      if (!link) return
      const state = await load(link.execution_id)
      state.messages[usage.message_id] = { ...usage, wu_id: link.wu_id, phase: link.phase }
      await store(link.execution_id, state)
    },
    async report(executionID, wuID = null) {
      if (!validId(executionID)) throw new Error("efficiency_report requires a safe execution_id")
      if (wuID !== null && !validId(wuID)) throw new Error("efficiency_report wu_id must be a safe identifier")
      const data = enabled ? await load(executionID) : { messages: {} }
      return { execution_id: executionID, wu_id: wuID, telemetry_enabled: enabled,
        ...summarizeUsage(data.messages, wuID), budget_seconds_are_not_tokens: true }
    },
  }
}
