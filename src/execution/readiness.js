// Execution readiness (P5). Diagnostic, never authority.
//
// Answers: "if I start BUILD now, can I complete REVIEW afterward?" It derives
// the concrete requirements from the frozen verification contract (the caller
// cannot invent capabilities), evaluates them against injected probes, and
// returns a structured result with every requirement — not just the first
// failure.
//
// Semantics: authority + READY ⇒ may begin. READY is never authorization.
//
// Two groups: STABLE (checked at BUILD; the runtime shape) and VOLATILE
// (re-checked before REVIEW: binaries, browser, external resources).

import { createHash } from "node:crypto"

const sha256 = (value) => createHash("sha256").update(value).digest("hex")

export function deriveRequirements(contract, { phase = "BUILD" } = {}) {
  const requirements = []
  const seen = new Set()
  const add = (requirement) => {
    if (!seen.has(requirement.capability)) {
      seen.add(requirement.capability)
      requirements.push(requirement)
    }
  }

  if (phase === "BUILD") {
    add({ capability: "contract.valid", volatility: "STABLE" })
    add({ capability: "builder.present", volatility: "STABLE" })
    add({ capability: "reviewer.present", volatility: "STABLE" })
    add({ capability: "verification.runner", volatility: "STABLE" })
    add({ capability: "reviewer.execute_declared_checks", volatility: "STABLE" })
    add({ capability: "workspace.supported", volatility: "STABLE" })
    add({ capability: "runtime.interrupt", volatility: "STABLE" })
  }

  // Volatile binaries from every declared command's program.
  for (const command of [...(contract?.setup ?? []), ...(contract?.commands ?? [])]) {
    if (typeof command?.program === "string" && command.program) {
      add({ capability: `binary.${command.program}`, program: command.program, volatility: "VOLATILE" })
    }
  }

  // Volatile capabilities declared explicitly (shell.node overlaps the node binary).
  for (const capability of contract?.capabilities ?? []) {
    if (capability !== "shell.node") add({ capability, volatility: "VOLATILE" })
  }

  if ((contract?.environment?.network_policy ?? "UNRESTRICTED") === "NETWORK_FORBIDDEN") {
    add({ capability: "network.isolation", volatility: "STABLE" })
  }

  return requirements
}

export async function evaluateReadiness(requirements, probe) {
  const checked = []
  for (const requirement of requirements) {
    const result = (await probe(requirement.capability, requirement)) ?? {}
    checked.push({
      capability: requirement.capability,
      volatility: requirement.volatility,
      status: result.status === "READY" ? "READY" : "BLOCKED",
      reason: result.reason ?? null,
    })
  }
  const blocked = checked.filter((entry) => entry.status === "BLOCKED")
  return { status: blocked.length ? "BLOCKED_CAPABILITY" : "READY", requirements: checked }
}

export function budgetStatus({ remaining, buildReserve = 0, reviewReserve = 0 }) {
  const required = buildReserve + reviewReserve
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining < required) {
    return {
      status: "BLOCKED_BUDGET",
      remaining,
      required,
      reason: `remaining budget ${remaining} is below the required ${required} (build ${buildReserve} + review ${reviewReserve}).`,
    }
  }
  return { status: "READY", remaining, required }
}

export function pathDigest(path) {
  return sha256(String(path ?? ""))
}

export function buildFingerprint(info = {}) {
  return {
    plugin_revision: info.pluginRevision ?? null,
    opencode_version: info.opencodeVersion ?? null,
    effective_profiles: info.profiles ?? {},
    node_version: info.nodeVersion ?? null,
    platform: info.platform ?? null,
    arch: info.arch ?? null,
    path_digest: info.pathDigest ?? null,
    binaries: info.binaries ?? {},
    browser: info.browser ?? null,
    reviewer_profile_hash: info.reviewerProfileHash ?? null,
  }
}

export async function checkExecutionReadiness({ contract, phase = "BUILD", probe, budget, info = {} }) {
  const requirements = deriveRequirements(contract, { phase })
  const capability = await evaluateReadiness(requirements, probe)
  const budgetResult = budgetStatus(budget ?? { remaining: null })

  const status = capability.status !== "READY"
    ? capability.status
    : budgetResult.status !== "READY"
      ? budgetResult.status
      : "READY"

  return {
    status,
    checked_at: new Date().toISOString(),
    phase,
    fingerprint: buildFingerprint(info),
    requirements: capability.requirements,
    budget: budgetResult,
  }
}
