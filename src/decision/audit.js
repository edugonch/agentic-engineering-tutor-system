import { mkdir, appendFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { validateDecisionAudit } from "./contracts.js"

const DEFAULT_AUDIT_FILENAME = ".harness/audit/jev-decisions.ndjson"
const AUDIT_SCHEMA_VERSION = "jev-shadow-audit-v1"

function sanitizeError(error) {
  if (!error) return undefined
  const message = error instanceof Error ? error.message : String(error)
  // Redact any likely bearer token or key fragments that might leak.
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key[:=]\s*\S+/gi, "api_key=[redacted]")
    .slice(0, 500)
}

function safeAuditPath(projectRoot, configuredPath) {
  if (!projectRoot) return undefined
  const path = configuredPath || DEFAULT_AUDIT_FILENAME
  if (isAbsolute(path)) {
    const rel = relative(projectRoot, path)
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error(`Jev audit path escapes the project root: ${path}`)
    }
  }
  const absolute = resolve(projectRoot, path)
  const rel = relative(resolve(projectRoot), absolute)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Jev audit path escapes the project root: ${path}`)
  }
  return absolute
}

/**
 * Build a redacted audit record. Never includes prompts, source code, secrets,
 * or repository contents.
 */
export function buildAuditRecord({ taskId, model, signals, latencyMs, status, error }) {
  const record = {
    timestamp: new Date().toISOString(),
    schemaVersion: AUDIT_SCHEMA_VERSION,
    taskId: String(taskId ?? ""),
    model: String(model ?? ""),
    latencyMs: Number(latencyMs) || 0,
    status,
  }
  if (signals !== undefined) record.signals = signals
  if (error !== undefined) record.error = sanitizeError(error)
  const validated = validateDecisionAudit(record)
  if (!validated.ok) throw new Error(`Invalid audit record: ${validated.error}`)
  return record
}

/**
 * Create an audit sink. If audit is disabled, writes are no-ops. If enabled,
 * records are appended as NDJSON under the project root.
 */
export function createAuditSink(settings, projectRoot) {
  if (!settings.auditEnabled) {
    return {
      async write(record) {
        // Audit disabled: validate silently but do not persist.
        const validated = validateDecisionAudit(record)
        if (!validated.ok) throw new Error(`Invalid audit record: ${validated.error}`)
      },
    }
  }

  let path
  try {
    path = safeAuditPath(projectRoot, settings.auditPath)
  } catch {
    path = undefined
  }

  return {
    async write(record) {
      const validated = validateDecisionAudit(record)
      if (!validated.ok) throw new Error(`Invalid audit record: ${validated.error}`)
      if (!path) return
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8")
    },
  }
}
