const DELEGATION_TOOLS = new Set(["subagent", "task"])
const GUARDED_REPEAT_TOOLS = new Set(["subagent", "task", "bash", "write", "edit", "patch", "apply_patch", "harness_initialize_project"])

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// Like positiveInteger but returns null (disabled) instead of a fallback when the
// value is absent or invalid. Used for limits that are OFF unless the operator
// opts in explicitly.
function nullablePositiveInteger(value) {
  if (value === undefined || value === null || value === "") return null
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

// Stable, machine-readable error codes so the orchestrator can classify a guard
// trip without parsing natural-language prose. The human-readable message is
// preserved for the model's benefit.
export const GUARD_ERROR_CODES = Object.freeze({
  TOOL_CALL_LIMIT_EXCEEDED: "HARNESS_TOOL_CALL_LIMIT_EXCEEDED",
  DELEGATION_LIMIT_EXCEEDED: "HARNESS_DELEGATION_LIMIT_EXCEEDED",
  REPEATED_MUTATION: "HARNESS_REPEATED_MUTATION",
  NO_PROGRESS: "HARNESS_NO_PROGRESS",
})

function guardError(code, message) {
  const error = new Error(message)
  error.name = "HarnessGuardError"
  error.code = code
  return error
}

export function readGuardSettings(env = {}) {
  return {
    // Both the total tool-call ceiling and the delegation ceiling are OFF by
    // default. A fixed per-turn delegation count is not a WU budget and was the
    // source of the WU-058 false stop; the durable WU budget, dispatch
    // reservations, per-agent steps, and the repeated-mutation guard are the
    // normal limits. The operator may still set either ceiling explicitly as an
    // emergency fuse.
    maxToolCalls: nullablePositiveInteger(env.HARNESS_MAX_TOOL_CALLS),
    maxDelegations: nullablePositiveInteger(env.HARNESS_MAX_DELEGATIONS),
    maxIdenticalMutations: positiveInteger(env.HARNESS_MAX_IDENTICAL_MUTATIONS, 4),
    // A provider-agnostic default can break model adapters that reject the
    // output-token parameter OpenCode derives from this option. Keep the
    // request untouched unless the owner explicitly opts in.
    maxOutputTokens: positiveInteger(env.HARNESS_MAX_OUTPUT_TOKENS, null),
  }
}

export function applyOutputTokenCap(options, maxOutputTokens) {
  if (!maxOutputTokens) return options
  if (!options.maxTokens || options.maxTokens > maxOutputTokens) {
    options.maxTokens = maxOutputTokens
  }
  return options
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function createTurnGuard(settings = readGuardSettings()) {
  const turns = new Map()
  const failures = new Map()

  function stateFor(sessionID) {
    const key = sessionID || "unknown-session"
    if (!turns.has(key)) {
      turns.set(key, { calls: 0, delegations: 0, lastSignature: null, identicalCount: 0 })
    }
    return [key, turns.get(key)]
  }

  return {
    before(input, output) {
      const [key, state] = stateFor(input.sessionID)
      state.calls += 1
      if (settings.maxToolCalls != null && state.calls > settings.maxToolCalls) {
        throw guardError(GUARD_ERROR_CODES.TOOL_CALL_LIMIT_EXCEEDED, `Harness circuit breaker: this session run exceeded ${settings.maxToolCalls} tool calls. Stop and report the blocker; do not delegate, retry, or create follow-up work. Session: ${key}`)
      }

      if (DELEGATION_TOOLS.has(input.tool)) {
        state.delegations += 1
        if (settings.maxDelegations != null && state.delegations > settings.maxDelegations) {
          throw guardError(GUARD_ERROR_CODES.DELEGATION_LIMIT_EXCEEDED, `Harness circuit breaker: this session run exceeded the configured ${settings.maxDelegations} subagent delegation ceiling. Stop and report the blocker.`)
        }
      }

      if (GUARDED_REPEAT_TOOLS.has(input.tool)) {
        const signature = `${input.tool}:${stableStringify(output?.args ?? {})}`
        state.identicalCount = signature === state.lastSignature ? state.identicalCount + 1 : 1
        state.lastSignature = signature
        if (state.identicalCount > settings.maxIdenticalMutations) {
          throw guardError(GUARD_ERROR_CODES.REPEATED_MUTATION, `Harness circuit breaker: the same ${input.tool} action was repeated ${state.identicalCount} times without changing its arguments. Stop and report the blocker.`)
        }
      } else {
        state.lastSignature = null
        state.identicalCount = 0
      }
    },
    // Wrap the actual Harness call: reads/checkpoints do not erase failures.
    // Two identical failures permit diagnosis; the third attempt is refused.
    // This cannot interrupt reasoning inside an outstanding provider request.
    async runHarness(sessionID, tool, args, run) {
      const key = sessionID || "unknown-session"
      const signature = `${tool}:${stableStringify(args)}`
      const prior = failures.get(key)?.get(signature)
      if (prior?.count >= 2) {
        throw guardError(GUARD_ERROR_CODES.NO_PROGRESS, "Harness repeated failure without progress. Record BLOCKED_TOOLING/checkpoint with the original error and required recovery; do not retry unchanged input or ask permission to record the blocker.")
      }
      try {
        const result = await run()
        const auditOnly = ["status", "verify", "recover", "checkpoint", "block"].includes(args?.action)
        if ((!auditOnly && result?.commit_status === "committed") ||
            ["merged", "recovered_existing_merge", "verified_external_merge"].includes(result?.status)) {
          failures.delete(key)
        }
        return result
      } catch (error) {
        const byAction = failures.get(key) ?? new Map()
        const message = String(error?.message ?? error)
        byAction.set(signature, { message, count: prior?.message === message ? prior.count + 1 : 1 })
        failures.set(key, byAction)
        throw error
      }
    },
    reset(sessionID) {
      if (sessionID) failures.delete(sessionID)
      else failures.clear()
      if (sessionID) turns.delete(sessionID)
      else turns.clear()
    },
    snapshot(sessionID) {
      const state = turns.get(sessionID || "unknown-session")
      return state ? { ...state } : { calls: 0, delegations: 0, lastSignature: null, identicalCount: 0 }
    },
  }
}
