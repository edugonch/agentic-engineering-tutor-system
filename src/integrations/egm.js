import { realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep, join } from "node:path"

export const EGM_UPSTREAM_REVISION = "5382b17619be07811a14b2146c7672620b34a791"

// Default-enabled but explicitly invoked EGM design critique; never a Harness WU implementation reviewer.
export const EGM_PROFILES = Object.freeze({
  "harness-egm-zoom-out": Object.freeze({ source: "zoom_out.md", standard: "zoom-out-standard.md" }),
  "harness-egm-design": Object.freeze({ source: "design_critic.md", standard: "feature-spec-standard.md" }),
  "harness-egm-readiness": Object.freeze({ source: "implementation_readiness.md", standard: "implementation-readiness-standard.md" }),
})
const MODES = Object.freeze({
  simplicity: "harness-egm-zoom-out",
  design: "harness-egm-design",
  readiness: "harness-egm-readiness",
})

export function egmEnabled(env = process.env) {
  const value = String(env.HARNESS_EGM_ENABLED ?? "1").trim().toLowerCase()
  if (value === "" || ["1", "true", "on"].includes(value)) return true
  if (["0", "false", "off"].includes(value)) return false
  throw new Error("HARNESS_EGM_ENABLED must be 1 or 0 (also accepts true/false, on/off).")
}

export function isEgmReviewer(agent) {
  return Object.hasOwn(EGM_PROFILES, String(agent ?? ""))
}

function inside(root, path) {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))
}

function isSensitive(path) {
  const segments = path.split(/[\\/]/).map(part => part.toLowerCase())
  return segments.some(part => part === ".git" || part === ".ssh" || part === ".aws" ||
    part === ".env" || (part.startsWith(".env.") && part !== ".env.example") ||
    part === "credentials" || part === "secrets")
}

// Tool-boundary denial is needed even if a customized/global agent profile is permissive.
// These checks do not claim complete host/session isolation (AGENTS.md may be inherited).
export async function assertEgmReviewerTool(event, { projectRoot, packageRoot, enabled }) {
  if (!isEgmReviewer(event?.agent)) return
  if (!enabled) throw new Error("EGM_DISABLED: reviewer tools disabled by HARNESS_EGM_ENABLED=0")
  if (event.tool !== "read" && event.tool !== "glob") {
    throw new Error("EGM_READ_ONLY: Goldfish reviewers may only use read and glob")
  }
  const canonicalProject = await realpath(projectRoot)
  const canonicalStandards = await realpath(join(packageRoot, "docs", "egm", "upstream", "standards"))
  if (event.tool === "read") {
    const path = event.input?.filePath ?? event.input?.file_path ?? event.input?.path
    if (typeof path !== "string" || !path.trim()) throw new Error("EGM_READ_SCOPE: read path required")
    const actual = await realpath(resolve(canonicalProject, path))
    if ((!inside(canonicalProject, actual) && !inside(canonicalStandards, actual)) || isSensitive(actual)) {
      throw new Error("EGM_READ_SCOPE: access outside project/EGM standards or to sensitive paths denied")
    }
    return
  }
  // Glob returns filenames, not contents. Limit it to the project; deny secret globbing.
  const rawPattern = event.input?.pattern
  const base = event.input?.path ?? event.input?.cwd ?? canonicalProject
  if (typeof rawPattern !== "string" || !rawPattern.trim() ||
    isAbsolute(rawPattern) || rawPattern.split(/[\\/]/).includes("..") || isSensitive(rawPattern)) {
    throw new Error("EGM_READ_SCOPE: invalid glob pattern")
  }
  const canonicalBase = await realpath(resolve(canonicalProject, base))
  if (!inside(canonicalProject, canonicalBase) || isSensitive(canonicalBase)) {
    throw new Error("EGM_READ_SCOPE: glob outside the project is denied")
  }
}

export function assertEgmDispatch(event, { enabled, activeExecution = false } = {}) {
  if (event?.tool !== "subagent" || !isEgmReviewer(event.input?.agent)) return
  if (!enabled) throw new Error("EGM_DISABLED: remove HARNESS_EGM_ENABLED=0 and restart OpenCode")
  if (event.agent !== "harness-orchestrator") throw new Error("EGM_DISPATCH_DENIED: only the Harness orchestrator can delegate EGM reviews")
  if (activeExecution) throw new Error("EGM_DESIGN_ONLY: no EGM subagent dispatch inside an activated WU; use the existing Harness reviewer")
}

export function egmReviewPrompt({ mode, target, standard }) {
  const agent = MODES[mode]
  if (!agent) throw new Error("EGM_MODE_INVALID: expected simplicity, design or readiness")
  return `Harness EGM selective design review (experimental OpenCode V2 adapter).
Do not begin a new Epic, activate a Work Unit, edit code, alter approval artifacts, merge or record a Harness review receipt.
The Elephant is the existing harness-orchestrator. Use exactly one NEW foreground subagent: ${agent}.
Supply ONLY these file paths to that subagent: design target ${target}, rubric ${standard}, plus project code/docs the target explicitly references and that are strictly necessary to verify a finding. Do not send the parent conversation, prior findings or memory. Do not reuse a child session.
The Goldfish must read the target and rubric, and return concise, evidence-backed Blocker/Major/Nit findings, including affected path and line where possible. Mark required inaccessible sources as NOT_REVIEWED, not PASS. The parent deduplicates into a SINGLE compact report; no iterative reviews, re-audits, extra reviewer calls or mandatory EGM approval rounds. Nits are advisory.
This is a design critique, not a candidate-bound WU implementation review, verification PASS or owner approval. Do not substitute it for harness-reviewer, frozen-candidate verification, or the controller's acceptance gates. Stop on failed delegation or missing required reads. A fresh child context is not proof of isolation from AGENTS.md or user/global configuration. Report that isolation remains unverified unless independently tested.
`
}

export async function registerHarnessEgmCommand(ctx, ownership, { env = process.env, packageRoot } = {}) {
  if (!egmEnabled(env)) return false
  if (!packageRoot) throw new Error("packageRoot required for EGM integration")
  await ctx.command.transform(editor => editor.add({
    name: "harness-egm-review",
    description: "One optional fresh Goldfish design review (simplicity, design, readiness)",
    execute: async ({ sessionID, prompt, delivery }) => {
      const text = String(prompt?.text ?? "").trim()
      const match = /^(simplicity|design|readiness)\s+(.+)$/is.exec(text)
      if (!match) throw new Error("Usage: /harness-egm-review <simplicity|design|readiness> <project-relative-design-file>")
      const mode = match[1].toLowerCase()
      const projectRoot = await realpath(ctx.location?.project?.canonical)
      const target = await realpath(resolve(projectRoot, match[2].trim()))
      if (!inside(projectRoot, target) || isSensitive(target)) throw new Error("EGM_TARGET_SCOPE: design file must be within the project")
      if (!(await stat(target)).isFile()) throw new Error("EGM_TARGET_SCOPE: design target must be a regular file")
      const agent = MODES[mode]
      const inventory = await ctx.agent.list()
      const records = Array.isArray(inventory) ? inventory : (inventory?.data ?? inventory?.agents)
      if (!Array.isArray(records) || !records.some(item => (item.id === agent || item.name === agent) &&
        item.disabled !== true && (item.mode === "subagent" || item.mode === "all"))) {
        throw new Error(`EGM_NOT_READY: ${agent} is not loaded as a subagent; restart OpenCode and verify the profile`)
      }
      const standard = await realpath(join(packageRoot, "docs", "egm", "upstream", "standards", EGM_PROFILES[agent].standard))
      await ownership.takeOwnership(sessionID)
      const forwarded = { ...prompt }
      if (Array.isArray(forwarded.files)) forwarded.files = forwarded.files.map(({ mention, ...file }) => file)
      await ctx.session.prompt({
        ...forwarded, sessionID,
        text: egmReviewPrompt({ mode, target, standard }),
        delivery,
      })
    },
  }))
  return true
}
