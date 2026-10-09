// Verification contract + declared-check runner (P3/P4, hardened).
//
// A Work Unit declares its verification checks up front as `program` + `args`
// (argv), never a raw shell string. This module is the only thing that executes
// commands — inside a disposable verification workspace, with a sanitized
// environment, process-group ownership, output caps, and honest capability
// reporting (network isolation is not yet enforceable, so NETWORK_FORBIDDEN is
// returned as BLOCKED_CAPABILITY rather than silently ignored).

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { disposeWorkspace, materializeCandidate } from "./verification-workspace.js"

const MAX_OUTPUT_BYTES = 1_048_576 // 1 MiB

export function validateVerificationContract(contract) {
  if (!contract || typeof contract !== "object") throw new Error("verification contract must be an object.")
  if (!Array.isArray(contract.commands) || contract.commands.length === 0) {
    throw new Error("verification contract must declare at least one command.")
  }
  const ids = new Set()
  if (contract.setup !== undefined && !Array.isArray(contract.setup)) throw new Error("setup must be an array of declared commands")
  for (const check of [...(contract.setup ?? []), ...contract.commands]) {
    if (!check || typeof check !== "object" || typeof check.id !== "string" || !check.id.trim()) {
      throw new Error("each verification command needs a non-empty id.")
    }
    if (typeof check.program !== "string" || !check.program.trim()) {
      throw new Error(`verification check "${check.id}" needs a non-empty program.`)
    }
    if (!Array.isArray(check.args) || check.args.some((arg) => typeof arg !== "string")) {
      throw new Error(`verification check "${check.id}" needs an args array of strings.`)
    }
    if (check.timeout_ms !== undefined && (!Number.isSafeInteger(check.timeout_ms) || check.timeout_ms < 1 || check.timeout_ms > 86_400_000)) {
      throw new Error(`verification check "${check.id}" requires a positive timeout_ms within 24 hours.`)
    }
    if (ids.has(check.id)) throw new Error(`duplicate verification check id: ${check.id}.`)
    ids.add(check.id)
  }
  const policy = contract.environment?.network_policy ?? "UNRESTRICTED"
  if (policy !== "UNRESTRICTED" && policy !== "NETWORK_FORBIDDEN") {
    throw new Error(`verification contract has an unknown network_policy: ${policy}.`)
  }
  return true
}

export function resolveCheck(contract, checkId) {
  return (contract.commands ?? []).find((check) => check.id === checkId) ?? null
}

// Sanitized environment allowlist. HOME/TMPDIR are redirected into the
// disposable workspace so tests cannot read or write the user's real home.
export function sanitizedEnv(workspace) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: workspace,
    TMPDIR: workspace,
    LANG: "C.UTF-8",
    HARNESS_VERIFICATION: "1",
  }
}

// Run a program with argv (no shell), in its own process group. On timeout and
// on normal close, the whole process group is killed. A grandchild that outlives
// its parent (and is orphaned out of the group) is a known POSIX limitation:
// full containment requires cgroups/containers, out of scope for this phase.
export function runCommand(program, args, { cwd, env = sanitizedEnv(cwd), timeoutMs = 30000, signal, maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    if (signal?.aborted) { resolve({ ok: false, aborted: true, exitCode: null, stdout: "", stderr: "", durationMs: 0 }); return }
    let child
    try {
      // OpenCode may be a compiled Bun executable: execPath is its CLI, not Node.
      // Resolve Node through the same PATH used by the declared npm/node checks.
      child = spawn("node", [fileURLToPath(new URL("./command-host.mjs", import.meta.url)), String(process.pid), program, ...args],
        { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error), exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: false, durationMs: Date.now() - startedAt })
      return
    }

    let stdout = ""
    let stderr = ""
    let truncated = false
    let timedOut = false
    let aborted = false
    let settled = false
    const append = (current, chunk) => {
      if (truncated) return current
      const next = current + String(chunk)
      if (next.length > maxOutputBytes) {
        truncated = true
        return next.slice(0, maxOutputBytes)
      }
      return next
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      // cleanup: kill any survivors in the process group
      try { process.kill(-child.pid, "SIGKILL") } catch {}
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, "SIGKILL") } catch {}
    }, timeoutMs)

    const abort = () => {
      aborted = true
      try { process.kill(-child.pid, "SIGKILL") } catch {}
    }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk) })
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk) })
    child.on("close", (code, signal) => {
      finish({ ok: code === 0 && !aborted && !timedOut, aborted, exitCode: code, signal: signal ?? null, timedOut, truncated, stdout, stderr, durationMs: Date.now() - startedAt })
    })
    child.on("error", (error) => {
      finish({ ok: false, error: String(error?.message ?? error), exitCode: null, stdout, stderr, truncated, timedOut, durationMs: Date.now() - startedAt })
    })
  })
}

export async function runDeclaredCheck(candidate, contract, checkId, { timeoutMs, budgetMs = Infinity, signal } = {}) {
  try {
    validateVerificationContract(contract)
  } catch (error) {
    return { status: "BLOCKED_INVALID_CONTRACT", check_id: checkId, reason: String(error?.message ?? error) }
  }

  const policy = contract.environment?.network_policy ?? "UNRESTRICTED"
  if (policy === "NETWORK_FORBIDDEN") {
    return {
      status: "BLOCKED_CAPABILITY",
      check_id: checkId,
      reason: "the contract requires NETWORK_FORBIDDEN, which this runner cannot yet enforce.",
      network_policy: policy,
    }
  }

  const check = resolveCheck(contract, checkId)
  if (!check) {
    return { status: "BLOCKED_UNDECLARED_CHECK", check_id: checkId, reason: `check "${checkId}" is not declared in the verification contract.` }
  }

  const { workspace } = await materializeCandidate(candidate)
  const started = Date.now()
  const setupResults = []
  const remaining = () => Math.max(0, budgetMs - (Date.now() - started))
  try {
    for (const setup of contract.setup ?? []) {
      if (remaining() <= 0) return { status: "BLOCKED_BUDGET", check_id: checkId, setup_results: setupResults }
      const result = await runCommand(setup.program, setup.args, { cwd: workspace, signal, timeoutMs: Math.min(setup.timeout_ms ?? 300000, remaining()) })
      setupResults.push({ id: setup.id, ...result })
      if (!result.ok) return { status: "FAIL", candidate_id: candidate.candidate_id, check_id: checkId,
        reason: `Declared setup ${setup.id} failed`, setup_results: setupResults, ...result }
    }
    if (remaining() <= 0) return { status: "BLOCKED_BUDGET", check_id: checkId, setup_results: setupResults }
    const result = await runCommand(check.program, check.args, { cwd: workspace, env: sanitizedEnv(workspace), signal, timeoutMs: Math.min(timeoutMs ?? check.timeout_ms ?? 30000, remaining()) })
    return {
      status: result.ok ? "PASS" : "FAIL",
      setup_results: setupResults,
      check_id: checkId,
      program: check.program,
      args: check.args,
      candidate_id: candidate.candidate_id,
      tree_hash: candidate.tree_hash,
      ...result,
      network_policy: policy,
      fingerprint: { node: process.version, cwd: workspace, timestamp: new Date().toISOString() },
    }
  } finally {
    await disposeWorkspace(workspace)
  }
}

// Run a check against the candidate's FROZEN verification contract (not a
// free-form contract supplied by the reviewer). This is the only path the
// harness_run_verification tool calls.
export async function runCandidateVerification(candidate, checkId, { timeoutMs, budgetMs, signal } = {}) {
  const contract = candidate.verification_contract
  if (!contract) {
    return { status: "BLOCKED_NO_CONTRACT", check_id: checkId, reason: "the candidate has no frozen verification contract." }
  }
  const result = await runDeclaredCheck(candidate, contract, checkId, { timeoutMs, budgetMs, signal })
  return { ...result, verification_contract_hash: candidate.manifest?.verification_contract?.contract_hash ?? null }
}
