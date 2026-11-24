// Project-governance gates for Epic activation and closure.
//
// The Harness core stays generic. A project opts in by committing a
// `harness.config.json` at its root with an explicit command envelope:
//
//   {
//     "governance": {
//       "epicActivationCommand": { "program": "npm", "args": ["run", "..."], "timeout_ms": 120000 },
//       "epicClosureCommand":    { "program": "npm", "args": ["run", "..."], "timeout_ms": 120000,
//                                  "require_candidate_sha": true }
//     }
//   }
//
// Arguments are program+argv (never a shell string). Placeholders are expanded
// from durable execution state: {epic_id}, {execution_id}, {mandate_id},
// {candidate_id}, {candidate_sha}, {merge_commit_sha}, {final_wu_id}. A
// configured gate that cannot resolve a required placeholder fails closed.
//
// Projects without this file keep the previous behavior exactly.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"
import { runCommand } from "./verification.js"

export const PROJECT_GOVERNANCE_CONFIG = "harness.config.json"
const MAX_TIMEOUT_MS = 86_400_000
const DEFAULT_TIMEOUT_MS = 120_000

function governanceError(code, message, extra = {}) {
  const error = new Error(message)
  error.name = "HarnessGovernanceError"
  error.code = code
  error.source = "project_governance"
  Object.assign(error, extra)
  return error
}

function normalizeCommand(raw, name, configPath) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw governanceError("EPIC_GATE_CONFIG_INVALID", `${PROJECT_GOVERNANCE_CONFIG}: governance.${name} must be an object.`, { config_path: configPath })
  }
  if (typeof raw.program !== "string" || raw.program.trim().length === 0) {
    throw governanceError("EPIC_GATE_CONFIG_INVALID", `${PROJECT_GOVERNANCE_CONFIG}: governance.${name}.program must be a non-empty string.`, { config_path: configPath })
  }
  const args = raw.args ?? []
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw governanceError("EPIC_GATE_CONFIG_INVALID", `${PROJECT_GOVERNANCE_CONFIG}: governance.${name}.args must be an array of strings.`, { config_path: configPath })
  }
  const timeout = raw.timeout_ms ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw governanceError("EPIC_GATE_CONFIG_INVALID", `${PROJECT_GOVERNANCE_CONFIG}: governance.${name}.timeout_ms must be a positive integer within 24 hours.`, { config_path: configPath })
  }
  return {
    program: raw.program.trim(),
    args: [...args],
    timeout_ms: timeout,
    require_candidate_sha: raw.require_candidate_sha !== false,
  }
}

// Reads and validates the optional project config. A missing file is the
// explicit backward-compatible "no gates" state. A present-but-malformed file
// fails closed so an editing mistake can never silently disable the gate.
export async function loadProjectGovernance(projectRoot) {
  const configPath = join(projectRoot, PROJECT_GOVERNANCE_CONFIG)
  let text
  try {
    text = await readFile(configPath, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return { path: null, activation: null, closure: null }
    throw governanceError("EPIC_GATE_CONFIG_UNREADABLE", `Cannot read ${PROJECT_GOVERNANCE_CONFIG}: ${error?.message ?? error}`, { config_path: configPath })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw governanceError("EPIC_GATE_CONFIG_INVALID", `${PROJECT_GOVERNANCE_CONFIG} is not valid JSON: ${error?.message ?? error}`, { config_path: configPath })
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw governanceError("EPIC_GATE_CONFIG_INVALID", `${PROJECT_GOVERNANCE_CONFIG} must contain a JSON object.`, { config_path: configPath })
  }
  const governance = parsed.governance
  if (governance === undefined || governance === null) {
    return { path: configPath, activation: null, closure: null }
  }
  if (typeof governance !== "object" || Array.isArray(governance)) {
    throw governanceError("EPIC_GATE_CONFIG_INVALID", `${PROJECT_GOVERNANCE_CONFIG}: governance must be an object.`, { config_path: configPath })
  }
  return {
    path: configPath,
    activation: normalizeCommand(governance.epicActivationCommand, "epicActivationCommand", configPath),
    closure: normalizeCommand(governance.epicClosureCommand, "epicClosureCommand", configPath),
  }
}

// The exact candidate a closure must be evaluated against. Prefer the final WU's
// recorded merge commit; fall back to the bound reviewed head. Returning null is
// meaningful: a configured closure gate that requires a candidate refuses to run
// without one rather than accepting an unbound Epic close.
export function resolveClosureCandidate(state) {
  const sequence = Array.isArray(state?.mandate?.wu_sequence) ? state.mandate.wu_sequence : []
  const finalWuId = sequence.at(-1) ?? state?.wu?.wu_id ?? null
  const completion = finalWuId ? state?.completed_wus?.[finalWuId] : null
  const candidateId = completion?.candidate_id ?? state?.merge?.candidate_id ?? state?.pr_binding?.candidate_id ?? null
  const mergeRecord = candidateId ? state?.merges?.[candidateId] : null
  const mergeCommitSha = state?.merge?.merge_commit_sha ?? mergeRecord?.merge_commit_sha ?? null
  const candidateSha = mergeCommitSha
    ?? (candidateId ? state?.pr_bindings?.[candidateId]?.head_sha : null)
    ?? state?.pr_binding?.head_sha
    ?? null
  return { final_wu_id: finalWuId, candidate_id: candidateId, candidate_sha: candidateSha, merge_commit_sha: mergeCommitSha }
}

function expand(value, vars) {
  return value.replace(/\{([a-z_]+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw governanceError("EPIC_GATE_UNKNOWN_PLACEHOLDER", `Unknown governance command placeholder ${match}; supported: ${Object.keys(vars).sort().join(", ")}.`)
    }
    const resolved = vars[key]
    if (resolved === null || resolved === undefined || resolved === "") {
      throw governanceError(`EPIC_GATE_MISSING_${key.toUpperCase()}`, `The governance command requires ${match}, but it is not available from durable execution state.`)
    }
    return String(resolved)
  })
}

function sha256(value) {
  return createHash("sha256").update(value ?? "").digest("hex")
}

function tail(value, limit = 4000) {
  const text = String(value ?? "")
  return text.length > limit ? text.slice(-limit) : text
}

// Runs the configured gate for one phase. Returns an auditable receipt on
// success, null when no gate is configured, and throws a fail-closed error
// (carrying the receipt) when the command is missing a required input, cannot
// start, times out or exits non-zero.
export async function runProjectGovernanceGate({
  projectRoot,
  phase,
  epicId,
  executionId = null,
  mandateId = null,
  state = null,
  config,
}) {
  if (!config) return null
  const command = phase === "activation" ? config.activation : config.closure
  if (!command) return null
  if (phase !== "activation" && phase !== "closure") throw governanceError("EPIC_GATE_PHASE_INVALID", `Unknown governance gate phase: ${phase}.`)
  if (typeof epicId !== "string" || epicId.trim().length === 0) {
    throw governanceError("EPIC_GATE_MISSING_EPIC_ID", "The configured Epic governance gate requires a canonical epic_id on the mandate.")
  }
  const candidate = phase === "closure"
    ? resolveClosureCandidate(state)
    : { final_wu_id: null, candidate_id: null, candidate_sha: null, merge_commit_sha: null }
  if (phase === "closure" && command.require_candidate_sha && !candidate.candidate_sha) {
    throw governanceError("EPIC_GATE_MISSING_CANDIDATE_SHA", "The configured Epic closure gate requires the final candidate/merge SHA, but none is recorded.")
  }
  const vars = {
    epic_id: epicId,
    execution_id: executionId,
    mandate_id: mandateId,
    candidate_id: candidate.candidate_id,
    candidate_sha: candidate.candidate_sha,
    merge_commit_sha: candidate.merge_commit_sha,
    final_wu_id: candidate.final_wu_id,
  }
  const program = expand(command.program, vars)
  const args = command.args.map((arg) => expand(arg, vars))
  const env = {
    ...process.env,
    HARNESS_GOVERNANCE_GATE: "1",
    HARNESS_GATE_PHASE: phase,
    HARNESS_EPIC_ID: epicId,
    HARNESS_EXECUTION_ID: executionId ?? "",
    HARNESS_MANDATE_ID: mandateId ?? "",
    HARNESS_CANDIDATE_ID: candidate.candidate_id ?? "",
    HARNESS_CANDIDATE_SHA: candidate.candidate_sha ?? "",
    HARNESS_MERGE_COMMIT_SHA: candidate.merge_commit_sha ?? "",
    HARNESS_FINAL_WU_ID: candidate.final_wu_id ?? "",
  }
  const checkedAt = new Date().toISOString()
  const result = await runCommand(program, args, { cwd: projectRoot, env, timeoutMs: command.timeout_ms })
  const receipt = {
    gate: phase === "activation" ? "epic-activation" : "epic-closure",
    config_path: config.path,
    command: [program, ...args],
    epic_id: epicId,
    execution_id: executionId,
    mandate_id: mandateId,
    candidate_id: candidate.candidate_id,
    candidate_sha: candidate.candidate_sha,
    merge_commit_sha: candidate.merge_commit_sha,
    final_wu_id: candidate.final_wu_id,
    exit_code: result.exitCode ?? null,
    timed_out: Boolean(result.timedOut),
    ok: Boolean(result.ok),
    duration_ms: result.durationMs ?? null,
    stdout_sha256: sha256(result.stdout),
    stderr_sha256: sha256(result.stderr),
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
    checked_at: checkedAt,
  }
  if (!result.ok) {
    const reason = result.timedOut
      ? `timed out after ${command.timeout_ms}ms`
      : result.error
        ? `failed to start: ${result.error}`
        : `exited with code ${result.exitCode}`
    throw governanceError(
      phase === "activation" ? "EPIC_ACTIVATION_GATE_FAILED" : "EPIC_CLOSURE_GATE_FAILED",
      `Epic ${phase} gate failed for ${epicId}: ${reason}.`,
      { gate_receipt: receipt, next_safe_action: "Repair the project governance evidence; do not activate or complete the Epic until the gate passes." },
    )
  }
  return receipt
}
