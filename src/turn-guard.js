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
// preserved verbatim for the model's benefit.
export const GUARD_ERROR_CODES = Object.freeze({
  TOOL_CALL_LIMIT_EXCEEDED: "HARNESS_TOOL_CALL_LIMIT_EXCEEDED",
  DELEGATION_LIMIT_EXCEEDED: "HARNESS_DELEGATION_LIMIT_EXCEEDED",
  REPEATED_MUTATION: "HARNESS_REPEATED_MUTATION",
})

function guardError(code, message) {
  const error = new Error(message)
  error.name = "HarnessGuardError"
  error.code = code
  return error
}

export function readGuardSettings(env = {}) {
  return {
    // Emergency runaway fuses, not durable execution budgets or authority.
    // The delegation ceiling is OFF by default: a fixed per-turn delegation
    // count is not a WU budget and was the source of the WU-058 false stop.
    // The durable WU budget, dispatch reservations, per-agent steps, and the
    // repeated-mutation guard are the normal limits. The operator may still set
    // an explicit emergency ceiling.
    maxToolCalls: positiveInteger(env.HARNESS_MAX_TOOL_CALLS, 250),
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
      if (state.calls > settings.maxToolCalls) {
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
    reset(sessionID) {
      if (sessionID) turns.delete(sessionID)
      else turns.clear()
    },
    snapshot(sessionID) {
      const state = turns.get(sessionID || "unknown-session")
      return state ? { ...state } : { calls: 0, delegations: 0, lastSignature: null, identicalCount: 0 }
    },
  }
}
