import { mkdir, appendFile, lstat, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { validateDecisionAudit } from "./contracts.js"

const DEFAULT_AUDIT_FILENAME = ".harness/audit/jev-decisions.ndjson"
const AUDIT_SCHEMA_VERSION = "jev-shadow-audit-v2"

function sanitizeError(error) {
  if (!error) return undefined
  const message = error instanceof Error ? error.message : String(error)
  // Redact any likely bearer token or key fragments that might leak.
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key[:=]\s*\S+/gi, "api_key=[redacted]")
    .slice(0, 500)
}

/**
 * Resolve the absolute path and verify that every existing component is inside
 * the project root after following symlinks. Returns the original absolute path
 * if safe, or throws if the destination escapes the root.
 */
async function safeAuditPath(projectRoot, configuredPath) {
  if (!projectRoot) return undefined
  const path = configuredPath || DEFAULT_AUDIT_FILENAME
  const absolute = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path)

  // Reject configured absolute paths that escape the project root logically.
  const relToRoot = relative(projectRoot, absolute)
  if (
    relToRoot === ".." ||
    relToRoot.startsWith(`..${sep}`)
  ) {
    throw new Error(`Jev audit path escapes the project root: ${path}`)
  }

  const rootReal = await realpath(projectRoot)

  // Walk existing path components, resolving symlinks, and confirm each stays
  // inside the canonical project root.
  const parts = relToRoot.split(sep).filter(Boolean)
  let cursor = rootReal
  for (const part of parts) {
    cursor = resolve(cursor, part)
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) {
        cursor = await realpath(cursor)
      }
      const rel = relative(rootReal, cursor)
      if (rel === ".." || rel.startsWith(`..${sep}`)) {
        throw new Error(`Jev audit path escapes the project root: ${path}`)
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        // Remaining components do not exist yet; the existing prefix is safe.
        break
      }
      throw error
    }
  }

  return absolute
}

/**
 * Build a redacted audit record. Never includes prompts, source code, secrets,
 * or repository contents.
 */
export function buildAuditRecord({
  taskId,
  requestedModel,
  actualModel,
  signals,
  usage,
  latencyMs,
  status,
  error,
}) {
  const record = {
    timestamp: new Date().toISOString(),
    schemaVersion: AUDIT_SCHEMA_VERSION,
    taskId: String(taskId ?? ""),
    requestedModel: String(requestedModel ?? ""),
    latencyMs: Number(latencyMs) || 0,
    status,
  }
  if (actualModel !== undefined) record.actualModel = String(actualModel)
  if (signals !== undefined) record.signals = signals
  if (usage !== undefined) record.usage = usage
  if (error !== undefined) record.error = sanitizeError(error)
  const validated = validateDecisionAudit(record)
  if (!validated.ok) throw new Error(`Invalid audit record: ${validated.error}`)
  return record
}

/**
 * Create an audit sink. If audit is disabled, writes are no-ops. If enabled,
 * records are appended as NDJSON under the project root, with symlink-aware
 * path verification at write time.
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

  return {
    async write(record) {
      const validated = validateDecisionAudit(record)
      if (!validated.ok) throw new Error(`Invalid audit record: ${validated.error}`)

      let absolute
      try {
        absolute = await safeAuditPath(projectRoot, settings.auditPath)
      } catch {
        return
      }
      if (!absolute) return

      await mkdir(dirname(absolute), { recursive: true })

      // Re-verify the real parent directory after creating missing components;
      // this catches symlinks created between planning and writing.
      const rootReal = await realpath(projectRoot)
      const parentReal = await realpath(dirname(absolute))
      const rel = relative(rootReal, parentReal)
      if (rel === ".." || rel.startsWith(`..${sep}`)) {
        return
      }

      const destination = resolve(parentReal, basename(absolute))
      await appendFile(destination, `${JSON.stringify(record)}\n`, "utf8")
    },
  }
}
