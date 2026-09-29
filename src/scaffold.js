import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const templateRoot = join(packageRoot, "templates")

const TEMPLATE_FILES = [
  "AGENTS.md",
  ".harness/PROJECT_STORY.md",
  ".harness/PROJECT_CHARTER.md",
  ".harness/PROJECT_STATE.md",
  ".harness/research/raw/README.md",
  ".harness/research/synthesis/README.md",
  ".harness/decisions/README.md",
  ".harness/epics/README.md",
  ".harness/work-units/README.md",
  ".harness/templates/EPIC.md",
  ".harness/templates/WORK_UNIT.md",
  ".harness/OPENCODE-CONFIG-FRAGMENT.jsonc",
  ".opencode/agents/harness-orchestrator.md",
  ".opencode/agents/harness-builder.md",
  ".opencode/agents/harness-researcher.md",
  ".opencode/agents/harness-reviewer.md",
  ".opencode/skills/project-intake/SKILL.md",
  ".opencode/skills/project-import/SKILL.md",
  ".opencode/skills/story-governance/SKILL.md",
  ".opencode/skills/research-gating/SKILL.md",
  ".opencode/skills/work-unit-authoring/SKILL.md",
]

const CONFIG_CANDIDATES = ["opencode.json", "opencode.jsonc"]

function assertProjectRoot(projectRoot) {
  if (!projectRoot || !isAbsolute(projectRoot)) throw new Error("OpenCode did not provide an absolute project directory.")
  return resolve(projectRoot)
}

function targetPath(root, relativePath) {
  if (isAbsolute(relativePath)) throw new Error("Absolute output paths are not allowed.")
  const target = resolve(root, relativePath)
  const rel = relative(root, target)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Path escapes the project root: ${relativePath}`)
  return target
}

function markdownValue(value) {
  const text = String(value ?? "").trim()
  return text || "[OWNER INPUT REQUIRED]"
}

function interpolate(content, values) {
  return content.replaceAll("{{PROJECT_NAME}}", markdownValue(values.project_name))
    .replaceAll("{{PROBLEM}}", markdownValue(values.problem))
    .replaceAll("{{DESIRED_OUTCOME}}", markdownValue(values.desired_outcome))
    .replaceAll("{{MVP}}", markdownValue(values.mvp))
    .replaceAll("{{SUCCESS_EVIDENCE}}", markdownValue(values.success_evidence))
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function assertNoSymlinkParents(root, destination) {
  const rel = relative(root, dirname(destination))
  let cursor = root
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) throw new Error(`Refusing to write through a symlinked directory: ${relative(root, cursor)}`)
      if (!info.isDirectory()) throw new Error(`Expected a directory at: ${relative(root, cursor)}`)
    } catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
  }
}

export async function initializeProject(projectRoot, values) {
  const root = await realpath(assertProjectRoot(projectRoot))
  for (const field of ["project_name", "problem", "desired_outcome", "mvp", "success_evidence"]) {
    if (!String(values[field] ?? "").trim()) throw new Error(`Initialization requires a non-empty ${field}. No files were written.`)
  }
  if (values.project_type && !["new", "existing"].includes(values.project_type)) {
    throw new Error('project_type must be "new" or "existing". No files were written.')
  }
  if (values.project_type === "existing" && !String(values.import_assessment ?? "").trim()) {
    throw new Error("Importing an existing project requires an owner-approved import_assessment. No files were written.")
  }
  const created = []
  const skipped = []

  for (const relativePath of TEMPLATE_FILES) {
    const destination = targetPath(root, relativePath)
    const template = join(templateRoot, relativePath)
    await assertNoSymlinkParents(root, destination)
    if (await exists(destination)) {
      skipped.push(relativePath)
      continue
    }
    const content = interpolate(await readFile(template, "utf8"), values)
    await mkdir(dirname(destination), { recursive: true })
    try {
      await writeFile(destination, content, { encoding: "utf8", flag: "wx" })
      created.push(relativePath)
    } catch (error) {
      if (error.code === "EEXIST") skipped.push(relativePath)
      else throw error
    }
  }

  if (values.project_type === "existing") {
    const assessment = String(values.import_assessment ?? "").trim()
    const relativePath = ".harness/IMPORT_ASSESSMENT.md"
    const destination = targetPath(root, relativePath)
    await assertNoSymlinkParents(root, destination)
    if (await exists(destination)) {
      skipped.push(relativePath)
    } else {
      await mkdir(dirname(destination), { recursive: true })
      const content = `# Existing Project Import Assessment\n\n> Owner-approved mapping recorded at initialization. This document is a migration aid; existing project records remain intact unless the owner explicitly changes their authority.\n\n${assessment}\n`
      try {
        await writeFile(destination, content, { encoding: "utf8", flag: "wx" })
        created.push(relativePath)
      } catch (error) {
        if (error.code === "EEXIST") skipped.push(relativePath)
        else throw error
      }
    }
  }

  let openCodeConfig = "not changed; review .harness/OPENCODE-CONFIG-FRAGMENT.jsonc and merge it into the project config if desired"
  for (const candidate of CONFIG_CANDIDATES) {
    if (await exists(join(root, candidate))) {
      openCodeConfig = `left unchanged (${candidate} already exists)`
      break
    }
  }

  return {
    status: "initialized",
    project: values.project_name,
    created,
    skipped,
    openCodeConfig,
    next: "Review PROJECT_STORY.md and PROJECT_CHARTER.md; then draft one finite first Epic and owner-approved WU budget.",
    warning: "Initialization writes only missing scaffold files. Review every generated file before execution; no issue, branch, commit, merge, or deployment was created.",
  }
}

export async function getProjectStatus(projectRoot) {
  const root = await realpath(assertProjectRoot(projectRoot))
  const present = []
  const missing = []
  for (const relativePath of TEMPLATE_FILES) {
    (await exists(targetPath(root, relativePath)) ? present : missing).push(relativePath)
  }
  let story = null
  const storyPath = targetPath(root, ".harness/PROJECT_STORY.md")
  if (await exists(storyPath)) story = (await readFile(storyPath, "utf8")).slice(0, 5000)
  return {
    initialized: present.includes(".harness/PROJECT_STORY.md"),
    present,
    missing,
    story_excerpt: story,
    next: missing.length ? "Review missing scaffold files; initialize only after explicit owner approval." : "Review the project story and define a finite, owner-approved first Epic.",
  }
}
