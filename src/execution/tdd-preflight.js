import { lstat, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { activeRecovery, requiresTdd } from "./process-recovery.js"

// Fail closed at the OpenCode V2 tool boundary while the active WU still owes RED.
// This is a pre-implementation gate, NOT a candidate acceptance shortcut.
const READ_TOOLS = new Set([
  "read", "glob", "grep",
  "harness_read_project_instructions", "harness_read_external_source",
  "harness_search_project_knowledge", "harness_read_project_knowledge", "harness_search_knowledge",
])
const TEST_FILE = /(?:^|[._-])(test|spec)\.(?:js|jsx|ts|tsx|cjs|mjs|py|rb|go|rs|java|cs|sh)$/i
const TEST_DIRS = new Set(["test", "tests", "spec", "specs", "__tests__", "__specs__"])

function within(root, path) {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))
}

// A candidate can use an existing project test runner such as check.cjs, but
// never infer that every .cjs or source file is a test file.
function isTestPath(path, contract) {
  const components = path.split(/[\\/]/)
  if (components.some(part => TEST_DIRS.has(part))) return true
  if (TEST_FILE.test(basename(path))) return true
  const checkPaths = (contract?.verification_contract?.commands ?? []).flatMap(c =>
    [c.program, ...(c.args ?? [])].filter(arg => typeof arg === "string" &&
      /\.(?:cjs|mjs|js|ts|py|rb|sh)$/.test(arg) && !arg.startsWith("-")))
  return checkPaths.includes(path)
}

async function safeProjectPath(projectRoot, userPath) {
  if (typeof userPath !== "string" || !userPath.trim()) throw new Error("TDD_RED_FIRST: a single test file path is required")
  const root = await realpath(projectRoot)
  const target = resolve(root, userPath)
  if (!within(root, target) || target === root) throw new Error("TDD_RED_FIRST: test edits must stay inside the project")
  // Check the real file or its nearest existing parent to reject symlink escapes
  // for both overwrites and newly created test files.
  let probe = target
  while (true) {
    try {
      const info = await lstat(probe)
      if (info.isSymbolicLink()) throw new Error("TDD_RED_FIRST: symlink writes are not allowed before RED")
      const actual = await realpath(probe)
      if (!within(root, actual)) throw new Error("TDD_RED_FIRST: path escapes the project via a symlink")
      break
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      const parent = dirname(probe)
      if (parent === probe) throw new Error("TDD_RED_FIRST: no existing project parent for test path")
      probe = parent
    }
  }
  return relative(root, target).split(sep).join("/")
}

export function tddGate(state) {
  if (!state?.wu || state.wu.completed || !requiresTdd(state)) return { status: "NOT_REQUIRED" }
  const wuId = state.wu.wu_id
  if (state.process_red?.[wuId]) return { status: "RED_RECORDED", wu_id: wuId }
  if (activeRecovery(state)) return { status: "RETROSPECTIVE_RECOVERY", wu_id: wuId }
  return { status: "RED_FIRST", wu_id: wuId }
}

export async function assertTddPreimplementation(event, context, projectRoot) {
  if (event?.agent !== "harness-builder" || !context?.tdd_gate || context.tdd_gate.status !== "RED_FIRST") return
  const tool = String(event.tool ?? "")
  if (READ_TOOLS.has(tool)) return
  if (tool === "edit" || tool === "write") {
    const file = event.input?.filePath ?? event.input?.file_path ?? event.input?.path
    const path = await safeProjectPath(projectRoot, file)
    if (isTestPath(path, context.contract)) return
  }
  throw new Error("TDD_RED_FIRST: required RED evidence has not been recorded. Author ONLY a focused test file using edit/write, then yield to the orchestrator to freeze the test-only baseline, run its declared verification, and record_red. No production changes, shell, apply_patch or opaque mutating tools before RED. Do not simulate RED by deleting implementation.")
}
