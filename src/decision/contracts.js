// Runtime-validated contracts for the Jev shadow-mode decision experiment.
// Jev estimates; the deterministic policy decides. These contracts keep the
// experiment auditable and guarantee that Jev cannot change routing, context,
// permissions, or actions.

export const PRIMARY_CONTEXT_OPTIONS = Object.freeze([
  "architecture",
  "governance",
  "design",
  "domain",
  "code",
  "none",
])

/**
 * @typedef {object} DecisionSignal
 * @property {number} difficulty integer 0–5
 * @property {number} needsArchitecture probability 0–1
 * @property {number} needsDesign probability 0–1
 * @property {number} needsSecurity probability 0–1 (classification only)
 * @property {string} primaryContext one of PRIMARY_CONTEXT_OPTIONS
 */

/**
 * Validate a DecisionSignal at runtime. Returns {ok, signal?, error?}.
 */
export function validateDecisionSignal(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "signal must be a plain object" }
  }
  const {
    difficulty,
    needsArchitecture,
    needsDesign,
    needsSecurity,
    primaryContext,
  } = value

  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 5) {
    return { ok: false, error: "difficulty must be an integer between 0 and 5" }
  }
  for (const [name, val] of [
    ["needsArchitecture", needsArchitecture],
    ["needsDesign", needsDesign],
    ["needsSecurity", needsSecurity],
  ]) {
    if (typeof val !== "number" || Number.isNaN(val) || val < 0 || val > 1) {
      return { ok: false, error: `${name} must be a number between 0 and 1` }
    }
  }
  if (!PRIMARY_CONTEXT_OPTIONS.includes(primaryContext)) {
    return {
      ok: false,
      error: `primaryContext must be one of ${PRIMARY_CONTEXT_OPTIONS.join(", ")}`,
    }
  }

  const unexpected = Object.keys(value).filter(
    (key) =>
      ![
        "difficulty",
        "needsArchitecture",
        "needsDesign",
        "needsSecurity",
        "primaryContext",
      ].includes(key),
  )
  if (unexpected.length) {
    return {
      ok: false,
      error: `unexpected signal fields: ${unexpected.join(", ")}`,
    }
  }

  return { ok: true, signal: value }
}

/**
 * @typedef {object} DecisionProvider
 * @property {(task: {taskId: string, state: string}) => Promise<{ok: boolean, signals?: DecisionSignal, latencyMs: number, error?: Error}>} estimate
 */

/**
 * Wrap a value and assert it satisfies the DecisionProvider contract.
 */
export function createDecisionProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error("DecisionProvider must be an object")
  }
  if (typeof provider.estimate !== "function") {
    throw new Error("DecisionProvider must expose estimate(task)")
  }
  return provider
}

/**
 * @typedef {object} DecisionPolicy
 * @property {(signals: DecisionSignal) => {action: "none", reason: string}} apply
 */

/**
 * Create the shadow-mode policy. It always returns action "none": Jev signals
 * are read-only audit inputs and never alter the orchestrator's routing,
 * permissions, context, or actions.
 */
export function createShadowPolicy() {
  return {
    apply(signals) {
      const validated = validateDecisionSignal(signals)
      if (!validated.ok) {
        throw new Error(`Invalid decision signal: ${validated.error}`)
      }
      return {
        action: "none",
        reason:
          "shadow-mode: Jev estimates are audited only; deterministic policy retains authority",
      }
    },
  }
}

/**
 * @typedef {object} DecisionAudit
 * @property {string} timestamp ISO 8601
 * @property {string} schemaVersion
 * @property {string} taskId non-sensitive identifier
 * @property {string} model
 * @property {DecisionSignal} [signals]
 * @property {number} latencyMs
 * @property {"ok" | "error" | "skipped"} status
 * @property {string} [error] sanitized, no secrets
 */

const AUDIT_ALLOWED_TOP_KEYS = new Set([
  "timestamp",
  "schemaVersion",
  "taskId",
  "model",
  "signals",
  "latencyMs",
  "status",
  "error",
])
const AUDIT_ALLOWED_STATUS = new Set(["ok", "error", "skipped"])

/**
 * Validate a redacted audit record at runtime.
 */
export function validateDecisionAudit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "audit record must be a plain object" }
  }
  const unexpected = Object.keys(value).filter(
    (key) => !AUDIT_ALLOWED_TOP_KEYS.has(key),
  )
  if (unexpected.length) {
    return {
      ok: false,
      error: `unexpected audit fields: ${unexpected.join(", ")}`,
    }
  }
  if (!AUDIT_ALLOWED_STATUS.has(value.status)) {
    return { ok: false, error: "audit status must be ok, error, or skipped" }
  }
  if (value.signals !== undefined) {
    const result = validateDecisionSignal(value.signals)
    if (!result.ok) return result
  }
  return { ok: true, audit: value }
}
