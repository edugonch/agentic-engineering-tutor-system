const DELEGATION_TOOLS = new Set(["subagent", "task"])
const GUARDED_REPEAT_TOOLS = new Set(["subagent", "task", "bash", "write", "edit", "patch", "apply_patch", "harness_initialize_project"])

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function readGuardSettings(env = {}) {
  return {
    maxToolCalls: positiveInteger(env.HARNESS_MAX_TOOL_CALLS, 40),
    maxDelegations: positiveInteger(env.HARNESS_MAX_DELEGATIONS, 3),
    maxIdenticalMutations: positiveInteger(env.HARNESS_MAX_IDENTICAL_MUTATIONS, 4),
    maxOutputTokens: positiveInteger(env.HARNESS_MAX_OUTPUT_TOKENS, 4096),
  }
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
        throw new Error(`Harness circuit breaker: this session run exceeded ${settings.maxToolCalls} tool calls. Stop and report the blocker; do not delegate, retry, or create follow-up work. Session: ${key}`)
      }

      if (DELEGATION_TOOLS.has(input.tool)) {
        state.delegations += 1
        if (state.delegations > settings.maxDelegations) {
          throw new Error(`Harness circuit breaker: this session run exceeded ${settings.maxDelegations} subagent delegations. Stop and report the blocker.`)
        }
      }

      if (GUARDED_REPEAT_TOOLS.has(input.tool)) {
        const signature = `${input.tool}:${stableStringify(output?.args ?? {})}`
        state.identicalCount = signature === state.lastSignature ? state.identicalCount + 1 : 1
        state.lastSignature = signature
        if (state.identicalCount > settings.maxIdenticalMutations) {
          throw new Error(`Harness circuit breaker: the same ${input.tool} action was repeated ${state.identicalCount} times without changing its arguments. Stop and report the blocker.`)
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
