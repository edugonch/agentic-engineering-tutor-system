// OpenCode Zen / TypeSafe Jev decision provider (shadow mode).
//
// Protocol verified from current official documentation:
// - OpenCode Console models: https://opencode.ai/v2/docs/console/models
// - TypeSafe API reference: https://docs.typesafe.ai/api.md
//
// Endpoint: POST https://opencode.ai/zen/v1/systemone
// Auth:     Authorization: Bearer <OpenCode Console API key>
// Request:  { model, state, questions }
// Response: { model, answers, usage }

const DEFAULT_ENDPOINT = "https://opencode.ai/zen/v1/systemone"
const DEFAULT_MODEL = "jev-1.13-free"
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MAX_RETRIES = 1
const MAX_STATE_LENGTH = 2000

function nonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function readJevSettings(env = {}) {
  return {
    enabled: env.HARNESS_JEV_ENABLED === "1" || env.HARNESS_JEV_ENABLED === "true",
    apiKey: String(env.HARNESS_JEV_API_KEY || ""),
    model: String(env.HARNESS_JEV_MODEL || DEFAULT_MODEL),
    endpoint: String(env.HARNESS_JEV_ENDPOINT || DEFAULT_ENDPOINT),
    timeoutMs: positiveInteger(env.HARNESS_JEV_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRetries: clamp(
      nonNegativeInteger(env.HARNESS_JEV_MAX_RETRIES, DEFAULT_MAX_RETRIES),
      0,
      1,
    ),
    auditEnabled: env.HARNESS_JEV_AUDIT === "1" || env.HARNESS_JEV_AUDIT === "true",
    auditPath: String(env.HARNESS_JEV_AUDIT_PATH || ""),
  }
}

/**
 * Return true only when Jev is explicitly enabled and an API key is supplied.
 * Missing credentials must never trigger a provider call.
 */
export function isJevReady(settings) {
  return settings.enabled === true && settings.apiKey.length > 0
}

const JEV_QUESTIONS = Object.freeze({
  difficulty: {
    type: "score",
    instructions:
      "Estimate the difficulty of this software engineering task for an AI coding assistant. Higher is harder.",
    criteria: [
      "0 - Trivial: a single obvious edit",
      "1 - Very easy: a small, well-scoped change",
      "2 - Easy: a routine change with clear boundaries",
      "3 - Moderate: multiple files or a modest design choice",
      "4 - Hard: significant design, coordination, or uncertainty",
      "5 - Very hard: deep architecture, security, or cross-cutting change",
    ],
  },
  needsArchitecture: {
    type: "noul",
    instructions:
      "Does this task likely require significant architecture or high-level system design decisions?",
    criteria: {
      true: "The task involves components, interfaces, major tech choices, or system structure.",
      false: "The task is local and does not reshape system structure.",
    },
  },
  needsDesign: {
    type: "noul",
    instructions:
      "Does this task likely require detailed design decisions such as APIs, data models, algorithms, or UX patterns?",
    criteria: {
      true: "The task needs explicit design choices beyond simple implementation.",
      false: "The task can be implemented within existing design constraints.",
    },
  },
  needsSecurity: {
    type: "noul",
    instructions:
      "Does this task touch security, authentication, authorization, secrets, trust boundaries, or sensitive data?",
    criteria: {
      true: "Security considerations are relevant.",
      false: "No security-sensitive dimension is apparent.",
    },
  },
  primaryContext: {
    type: "choice",
    instructions: "Which context dimension is most relevant for this task?",
    criteria: {
      architecture:
        "System structure, components, interfaces, or major technology choices.",
      governance:
        "Project process, scope, approvals, Epics, Work Units, or ownership.",
      design: "APIs, data models, algorithms, or UX patterns.",
      domain: "Business logic, user needs, or problem domain knowledge.",
      code: "Implementation details in existing source code.",
      none: "No specific context dominates.",
    },
  },
})

const EXPECTED_RESPONSE_KEYS = new Set(["model", "answers", "usage"])

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validateUsage(value) {
  if (value === undefined) return { ok: true, usage: undefined }
  if (!isPlainObject(value)) {
    return { ok: false, error: "usage must be an object" }
  }
  const unexpected = Object.keys(value).filter(
    (key) => key !== "input_tokens" && key !== "output_tokens",
  )
  if (unexpected.length) {
    return { ok: false, error: `unexpected usage fields: ${unexpected.join(", ")}` }
  }
  for (const key of ["input_tokens", "output_tokens"]) {
    const val = value[key]
    if (val !== undefined && (!Number.isInteger(val) || val < 0)) {
      return { ok: false, error: `${key} must be a non-negative integer` }
    }
  }
  return { ok: true, usage: value }
}

function validateJevResponse(body) {
  if (!isPlainObject(body)) {
    return { ok: false, error: "Jev response body must be an object" }
  }
  const unexpectedTop = Object.keys(body).filter(
    (key) => !EXPECTED_RESPONSE_KEYS.has(key),
  )
  if (unexpectedTop.length) {
    return {
      ok: false,
      error: `unexpected top-level response fields: ${unexpectedTop.join(", ")}`,
    }
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    return { ok: false, error: "Jev response must include a model string" }
  }
  if (!isPlainObject(body.answers)) {
    return { ok: false, error: "Jev response must include an answers object" }
  }

  const usageValidated = validateUsage(body.usage)
  if (!usageValidated.ok) {
    return { ok: false, error: usageValidated.error }
  }

  const required = ["difficulty", "needsArchitecture", "needsDesign", "needsSecurity", "primaryContext"]
  for (const key of required) {
    if (!(key in body.answers)) {
      return { ok: false, error: `missing answer for question ${key}` }
    }
  }

  const answers = body.answers
  const unexpectedAnswers = Object.keys(answers).filter(
    (key) => !required.includes(key),
  )
  if (unexpectedAnswers.length) {
    return {
      ok: false,
      error: `unexpected answer keys: ${unexpectedAnswers.join(", ")}`,
    }
  }

  const difficultyAnswer = answers.difficulty
  if (difficultyAnswer.type !== "score" || typeof difficultyAnswer.score !== "number") {
    return { ok: false, error: "difficulty answer must be a score with a numeric score" }
  }
  const roundedDifficulty = Math.round(difficultyAnswer.score)
  if (roundedDifficulty < 0 || roundedDifficulty > 5) {
    return { ok: false, error: "difficulty score must round to 0–5" }
  }

  const noulKeys = ["needsArchitecture", "needsDesign", "needsSecurity"]
  for (const key of noulKeys) {
    const answer = answers[key]
    if (answer.type !== "noul" || typeof answer.noul !== "number") {
      return { ok: false, error: `${key} answer must be a noul with numeric noul` }
    }
    if (answer.noul < 0 || answer.noul > 1) {
      return { ok: false, error: `${key} noul must be between 0 and 1` }
    }
  }

  const contextAnswer = answers.primaryContext
  if (
    contextAnswer.type !== "choice" ||
    typeof contextAnswer.choice !== "string"
  ) {
    return {
      ok: false,
      error: "primaryContext answer must be a choice with a string choice",
    }
  }
  const allowedContexts = Object.keys(JEV_QUESTIONS.primaryContext.criteria)
  if (!allowedContexts.includes(contextAnswer.choice)) {
    return {
      ok: false,
      error: `primaryContext choice must be one of ${allowedContexts.join(", ")}`,
    }
  }

  return {
    ok: true,
    actualModel: body.model,
    signals: {
      difficulty: roundedDifficulty,
      needsArchitecture: answers.needsArchitecture.noul,
      needsDesign: answers.needsDesign.noul,
      needsSecurity: answers.needsSecurity.noul,
      primaryContext: contextAnswer.choice,
    },
    usage: usageValidated.usage,
  }
}

function truncateState(state) {
  const text = String(state ?? "")
  if (text.length <= MAX_STATE_LENGTH) return text
  return text.slice(0, MAX_STATE_LENGTH)
}

function isRetryableStatus(status) {
  return status === 429 || status === 529 || status >= 500
}

function isRetryableError(error) {
  return error.name === "AbortError" || error.name === "TypeError"
}

/**
 * Execute a timed fetch that covers the request, headers, body reading and
 * JSON parsing. The timer is not cleared until the whole operation finishes or
 * fails, so a stalled body read aborts within the configured timeout.
 */
async function timedJevFetch(fetchImpl, endpoint, init, timeoutMs) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(endpoint, {
      ...init,
      signal: controller.signal,
    })
    if (!response.ok) {
      const error = new Error(`Jev HTTP ${response.status}`)
      error.status = response.status
      throw error
    }
    try {
      return await response.json()
    } catch (parseError) {
      if (parseError.name === "AbortError") {
        throw parseError
      }
      throw new Error(`Jev response is not valid JSON: ${parseError.message}`)
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Create a Jev decision provider. The optional `deps.fetch` is exposed for
 * tests and never reads private credential stores.
 */
export function createJevDecisionProvider(settings, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch
  if (!fetchImpl) {
    throw new Error("fetch is required for the Jev provider")
  }

  return {
    async estimate({ taskId, state }) {
      const start = Date.now()
      const body = {
        model: settings.model,
        state: truncateState(state),
        questions: JEV_QUESTIONS,
      }
      const headers = { "Content-Type": "application/json" }
      if (settings.apiKey) {
        headers["Authorization"] = `Bearer ${settings.apiKey}`
      }

      let lastError
      const attempts = 1 + settings.maxRetries
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const json = await timedJevFetch(
            fetchImpl,
            settings.endpoint,
            { method: "POST", headers, body: JSON.stringify(body) },
            settings.timeoutMs,
          )

          const validated = validateJevResponse(json)
          if (!validated.ok) {
            return {
              ok: false,
              latencyMs: Date.now() - start,
              error: new Error(validated.error),
            }
          }

          return {
            ok: true,
            actualModel: validated.actualModel,
            signals: validated.signals,
            usage: validated.usage,
            latencyMs: Date.now() - start,
          }
        } catch (error) {
          if (error.name === "AbortError") {
            const timeoutError = new Error("Jev request timed out")
            timeoutError.status = 408
            if (attempt < attempts) {
              lastError = timeoutError
              continue
            }
            return {
              ok: false,
              latencyMs: Date.now() - start,
              error: timeoutError,
            }
          }
          if (isRetryableError(error) && attempt < attempts) {
            lastError = error
            continue
          }
          if (error.status && isRetryableStatus(error.status) && attempt < attempts) {
            lastError = error
            continue
          }
          return {
            ok: false,
            latencyMs: Date.now() - start,
            error: error instanceof Error ? error : new Error(String(error)),
          }
        }
      }

      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: lastError || new Error("Jev request failed after retries"),
      }
    },
  }
}
