// Two independent roots: canonical project owns durable Harness state, while a
// moved OpenCode session owns the current Git checkout. Never infer the latter
// from ctx.location.project.canonical: SDK documents that as plugin-location
// identity, not the location of every session served by the instance.
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

const exec = promisify(execFile)
const git = async (cwd, ...args) => {
  const { stdout } = await exec("git", ["rev-parse", ...args], {
    cwd, timeout: 15000, maxBuffer: 8192, encoding: "utf8",
  })
  return stdout.trim()
}

async function identity(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new Error("SCOPE_RECOVERY_SESSION_LOCATION: session Git directory must be absolute")
  }
  const physical = await realpath(root)
  const [top, common] = await Promise.all([
    git(physical, "--show-toplevel"),
    git(physical, "--path-format=absolute", "--git-common-dir"),
  ])
  return { top: await realpath(resolve(physical, top)), common: await realpath(resolve(physical, common)) }
}

export async function verifyScopeCheckoutRoots(canonicalRoot, checkoutRoot) {
  let canonical, actual
  try {
    canonical = await identity(canonicalRoot)
    actual = await identity(checkoutRoot)
  } catch (error) {
    throw new Error("SCOPE_RECOVERY_GIT_LOCATION: " + error.message)
  }
  if (canonical.common !== actual.common) {
    throw new Error("SCOPE_RECOVERY_FOREIGN_PROJECT: session checkout is not a linked worktree of the canonical controller project")
  }
  return { checkoutRoot: actual.top, canonicalRoot: canonical.top }
}

// Runtime-only API: no model-controlled checkout path. OpenCode may move a
// session without reloading the plugin; authenticated Session.Info is authority
// for the current checkout, not the plugin instance's frozen ctx.location.
export async function resolveScopeRuntimeCheckout(ctx, canonicalRoot, sessionID) {
  if (typeof sessionID !== "string" || !sessionID.trim() || typeof ctx?.session?.get !== "function") {
    throw new Error("SCOPE_RECOVERY_SESSION_IDENTITY: runtime session.get and caller session ID required")
  }
  const response = await ctx.session.get({ sessionID })
  const session = response?.data ?? response
  if (session?.id !== sessionID || session.parentID || session.agent !== "harness-orchestrator") {
    throw new Error("SCOPE_RECOVERY_SESSION_IDENTITY: only the actual root orchestrator may reconcile scope")
  }
  const projectID = ctx.location?.project?.id
  if (projectID && session.projectID && projectID !== session.projectID) {
    throw new Error("SCOPE_RECOVERY_SESSION_IDENTITY: session project differs from controller project")
  }
  const directory = session.location?.directory ?? session.directory
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("SCOPE_RECOVERY_SESSION_LOCATION: OpenCode session location missing; do not silently fall back to the plugin location")
  }
  return verifyScopeCheckoutRoots(canonicalRoot, directory)
}
