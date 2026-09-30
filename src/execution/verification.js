// Verification contract + declared-check runner (P3/P4).
//
// A Work Unit declares its verification checks up front. The reviewer never
// improvises an arbitrary shell command; it runs a declared check by id, and
// this module is the only thing that executes commands — inside a disposable
// verification workspace, with a sanitized environment and process-group
// ownership so cleanup kills only the workspace's processes.

import { spawn } from "node:child_process"
import { disposeWorkspace, materializeCandidate } from "./verification-workspace.js"

export function validateVerificationContract(contract) {
  if (!contract || typeof contract !== "object") throw new Error("verification contract must be an object.")
  if (!Array.isArray(contract.commands) || contract.commands.length === 0) {
    throw new Error("verification contract must declare at least one command.")
  }
  const ids = new Set()
  for (const check of contract.commands) {
    if (!check || typeof check !== "object" || typeof check.id !== "string" || !check.id.trim()) {
      throw new Error("each verification command needs a non-empty id.")
    }
    if (typeof check.command !== "string" || !check.command.trim()) {
      throw new Error(`verification check "${check.id}" needs a non-empty command string.`)
    }
    if (ids.has(check.id)) throw new Error(`duplicate verification check id: ${check.id}.`)
    ids.add(check.id)
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

// Run a command in its own process group; timeout kills the whole group.
export function runCommand(command, { cwd, env = sanitizedEnv(cwd), timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(command, { cwd, env, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error), exitCode: null, stdout: "", stderr: "", timedOut: false, durationMs: Date.now() - startedAt })
      return
    }
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, "SIGKILL") } catch {}
    }, timeoutMs)
    child.stdout?.on("data", (chunk) => { stdout += chunk })
    child.stderr?.on("data", (chunk) => { stderr += chunk })
    child.on("close", (code, signal) => {
      finish({ ok: code === 0, exitCode: code, signal: signal ?? null, timedOut, stdout, stderr, durationMs: Date.now() - startedAt })
    })
    child.on("error", (error) => {
      finish({ ok: false, error: String(error?.message ?? error), exitCode: null, stdout, stderr, timedOut, durationMs: Date.now() - startedAt })
    })
  })
}

export async function runDeclaredCheck(candidate, contract, checkId, { timeoutMs = 30000 } = {}) {
  try {
    validateVerificationContract(contract)
  } catch (error) {
    return { status: "BLOCKED_INVALID_CONTRACT", check_id: checkId, reason: String(error?.message ?? error) }
  }
  const check = resolveCheck(contract, checkId)
  if (!check) {
    return { status: "BLOCKED_UNDECLARED_CHECK", check_id: checkId, reason: `check "${checkId}" is not declared in the verification contract.` }
  }

  const { workspace } = await materializeCandidate(candidate)
  try {
    const result = await runCommand(check.command, { cwd: workspace, env: sanitizedEnv(workspace), timeoutMs })
    return {
      status: result.ok ? "PASS" : "FAIL",
      check_id: checkId,
      command: check.command,
      candidate_id: candidate.candidate_id,
      tree_hash: candidate.tree_hash,
      ...result,
      fingerprint: { node: process.version, cwd: workspace, timestamp: new Date().toISOString() },
    }
  } finally {
    await disposeWorkspace(workspace)
  }
}
