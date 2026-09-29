// Phase 0 spike: minimal continuation driver.
//
// Answers ONE question empirically, inside a real OpenCode runtime:
//
//   Can the plugin turn `steps` exhaustion into a recoverable pause — issuing
//   `ctx.session.prompt(...)` to continue — WITHOUT resetting the hard turn
//   guard (HARNESS_MAX_TOOL_CALLS / HARNESS_MAX_DELEGATIONS) and WITHOUT
//   continuing past a permission denial?
//
// The design is deliberately narrow (maxContinuations defaults to 1). It does
// NOT build the full Epic loop. It is env-gated (HARNESS_CONTINUATION_ENABLED=1)
// so it changes nothing when disabled.
//
// Two parts are split so the pure logic is unit-testable without a runtime:
//   - shouldContinue(probe, maxContinuations)  (pure, exported)
//   - createContinuationDriver(ctx, opts)       (runtime wiring)

function positiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function readContinuationSettings(env = {}) {
  return {
    enabled: env.HARNESS_CONTINUATION_ENABLED === "1" || env.HARNESS_CONTINUATION_ENABLED === "true",
    maxContinuations: positiveInt(env.HARNESS_CONTINUATION_MAX, 1),
  }
}

// Pure continuation decision. A continuation is only a candidate when the
// session is a registered probe, it actually exhausted its configured steps,
// it is not blocked, and it has not exhausted its continuation budget.
export function shouldContinue(probe, maxContinuations) {
  if (!probe) return { continue: false, reason: "not-a-probe-session" }
  if (probe.blocked) return { continue: false, reason: "blocked" }
  if (probe.continuationsUsed >= maxContinuations) return { continue: false, reason: "max-continuations" }
  if (probe.stepCount < probe.steps) return { continue: false, reason: "steps-not-exhausted" }
  return { continue: true }
}

const CONTINUE_TEXT =
  "Continue from the durable checkpoint. Do not reset any budget, authority, or permission. " +
  "If you have reached the terminal sentinel or a hard blocker, stop and report instead of acting."

function sessionIdFromEvent(event) {
  return (
    event?.properties?.sessionID ??
    event?.properties?.sessionId ??
    event?.sessionID ??
    event?.sessionId ??
    null
  )
}

export function createContinuationDriver(ctx, opts = {}) {
  const { enabled, maxContinuations } = { ...readContinuationSettings(), ...opts }
  const probes = new Map() // sessionID -> { steps, stepCount, continuationsUsed, blocked, sentinel }
  const internalPrompts = new Set() // sessionIDs with an internal prompt in flight

  function onContext(event) {
    if (!enabled) return
    const probe = probes.get(event.sessionID)
    if (probe) probe.stepCount += 1
  }

  // The prompt hook calls this to decide whether a fresh prompt resets the hard
  // turn guard. A controller-issued continuation prompt must NOT reset it; a
  // human/external prompt must.
  function isInternalPrompt(sessionID) {
    if (internalPrompts.has(sessionID)) {
      internalPrompts.delete(sessionID)
      return true
    }
    return false
  }

  function registerProbe({ sessionID, steps, sentinel }) {
    if (!sessionID) throw new Error("registerProbe requires sessionID.")
    if (!Number.isInteger(steps) || steps < 1) throw new Error("registerProbe requires a positive integer steps.")
    probes.set(sessionID, { steps, stepCount: 0, continuationsUsed: 0, blocked: false, sentinel: sentinel ?? null })
    return { registered: true, sessionID, steps, sentinel: sentinel ?? null }
  }

  function markBlocked(sessionID) {
    const probe = probes.get(sessionID)
    if (probe) probe.blocked = true
    return { blocked: Boolean(probe), sessionID }
  }

  function getProbe(sessionID) {
    const probe = probes.get(sessionID)
    return probe ? { ...probe } : null
  }

  function listProbes() {
    return [...probes.entries()].map(([sessionID, probe]) => ({ sessionID, ...probe }))
  }

  // Called for every event; only reacts to session.idle for registered probes.
  async function onEvent(event) {
    if (!enabled) return false
    if (event?.type !== "session.idle") return false
    const sessionID = sessionIdFromEvent(event)
    if (!sessionID) return false
    return onIdle(sessionID)
  }

  async function onIdle(sessionID) {
    const probe = probes.get(sessionID)
    const decision = shouldContinue(probe, maxContinuations)
    if (!decision.continue) return false
    probe.continuationsUsed += 1
    internalPrompts.add(sessionID)
    try {
      await ctx.session.prompt({ sessionID, text: CONTINUE_TEXT })
      return true
    } catch (error) {
      internalPrompts.delete(sessionID)
      throw error
    }
  }

  return {
    enabled,
    maxContinuations,
    onContext,
    isInternalPrompt,
    registerProbe,
    markBlocked,
    getProbe,
    listProbes,
    onEvent,
    onIdle,
  }
}
