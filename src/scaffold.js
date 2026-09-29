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
  ".harness/references/ENGINEERING-KNOWLEDGE.md",
  ".harness/research/raw/README.md",
  ".harness/research/synthesis/README.md",
  ".harness/decisions/README.md",
  ".harness/epics/README.md",
  ".harness/work-units/README.md",
  ".harness/knowledge/README.md",
  ".harness/templates/EPIC.md",
  ".harness/templates/WORK_UNIT.md",
  ".harness/templates/ADR.md",
  ".harness/templates/RESEARCH_RECORD.md",
  ".harness/templates/RESEARCH_SYNTHESIS.md",
  ".harness/templates/REQUIREMENT_SPEC.md",
  ".harness/templates/USER_STORY.md",
  ".harness/OPENCODE-CONFIG-FRAGMENT.jsonc",
  ".opencode/agents/harness-orchestrator.md",
  ".opencode/agents/harness-builder.md",
  ".opencode/agents/harness-researcher.md",
  ".opencode/agents/harness-reviewer.md",
  ".opencode/agents/harness-designer.md",
  ".opencode/skills/project-intake/SKILL.md",
  ".opencode/skills/project-import/SKILL.md",
  ".opencode/skills/architecture-decision/SKILL.md",
  ".opencode/skills/reference-library-search/SKILL.md",
  ".opencode/skills/story-governance/SKILL.md",
  ".opencode/skills/research-gating/SKILL.md",
  ".opencode/skills/work-unit-authoring/SKILL.md",
]

const CONFIG_CANDIDATES = ["opencode.json", "opencode.jsonc"]
const STORY_AUTHORITY_CANDIDATES = ["PROJECT_STORY.md", "docs/PROJECT_STORY.md", "docs/product/PROJECT_STORY.md", "docs/product/EPIC_STORY.md", ".harness/PROJECT_STORY.md"]
const STATE_AUTHORITY_CANDIDATES = ["PROJECT_STATE.md", "docs/PROJECT_STATE.md", "docs/product/PROJECT_STATE.md", ".harness/PROJECT_STATE.md"]

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

  const storyCandidates = values.project_type === "existing"
    ? await findExisting(root, STORY_AUTHORITY_CANDIDATES.filter((path) => path !== ".harness/PROJECT_STORY.md"))
    : []
  const stateCandidates = values.project_type === "existing"
    ? await findExisting(root, STATE_AUTHORITY_CANDIDATES.filter((path) => path !== ".harness/PROJECT_STATE.md"))
    : []
  if (storyCandidates.length > 1 && !String(values.project_story_ref ?? "").trim()) {
    throw new Error(`Existing-project import found multiple story authority candidates (${storyCandidates.join(", ")}). Set project_story_ref to the owner-selected exact source. No files were written.`)
  }
  if (stateCandidates.length > 1 && !String(values.project_state_ref ?? "").trim()) {
    throw new Error(`Existing-project import found multiple state authority candidates (${stateCandidates.join(", ")}). Set project_state_ref to the owner-selected exact source. No files were written.`)
  }
  const existingStory = storyCandidates[0] ?? null
  const existingState = stateCandidates[0] ?? null
  const storyRef = String(values.project_story_ref ?? existingStory ?? "").trim()
  const stateRef = String(values.project_state_ref ?? existingState ?? "").trim()
  const paths = TEMPLATE_FILES.filter((path) => {
    if (values.project_type !== "existing") return true
    if (path === ".harness/PROJECT_STORY.md" && storyRef) return false
    if (path === ".harness/PROJECT_STATE.md" && stateRef) return false
    return true
  })

  for (const relativePath of paths) {
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

  for (const [kind, ref, localCandidate] of [["PROJECT_STORY", storyRef, storyRef === existingStory ? existingStory : null], ["PROJECT_STATE", stateRef, stateRef === existingState ? existingState : null]]) {
    if (!ref) continue
    const pointerPath = `.harness/${kind}_REF.md`
    const destination = targetPath(root, pointerPath)
    await assertNoSymlinkParents(root, destination)
    if (await exists(destination)) {
      skipped.push(pointerPath)
      continue
    }
    await mkdir(dirname(destination), { recursive: true })
    const content = `# ${kind} authority reference\n\nCanonical source: ${ref}\n\n${localCandidate ? "This local project document remains the live authority; the Harness scaffold does not create a competing copy." : "This external source remains the live authority. Retrieve it by its exact ID and current revision through the project's configured access route before making a decision. Imported snapshots in .harness/knowledge are historical references until verified."}\n`
    try {
      await writeFile(destination, content, { encoding: "utf8", flag: "wx" })
      created.push(pointerPath)
    } catch (error) {
      if (error.code === "EEXIST") skipped.push(pointerPath)
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

  let openCodeConfig = "not changed; replace the model placeholders in .harness/OPENCODE-CONFIG-FRAGMENT.jsonc with IDs from `opencode models`, then merge it into the project config"
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
    authority_references: { project_story: storyRef || null, project_state: stateRef || null },
    next: values.project_type === "existing"
      ? "Review the import assessment, knowledge index, and every authority reference against its live source. Reuse current research by exact ID/revision before collecting it again; then draft one finite next Epic only after owner approval."
      : "Review PROJECT_STORY.md and PROJECT_CHARTER.md; then draft one finite first Epic and owner-approved WU budget.",
    warning: "Initialization writes only missing scaffold files. Review every generated file before execution; no issue, branch, commit, merge, or deployment was created.",
  }
}

export async function getProjectStatus(projectRoot) {
  const root = await realpath(assertProjectRoot(projectRoot))
  const present = []
  const missing = []
  const storyRefExists = await exists(targetPath(root, ".harness/PROJECT_STORY_REF.md"))
  const stateRefExists = await exists(targetPath(root, ".harness/PROJECT_STATE_REF.md"))
  for (const relativePath of TEMPLATE_FILES) {
    if (relativePath === ".harness/PROJECT_STORY.md" && storyRefExists) continue
    if (relativePath === ".harness/PROJECT_STATE.md" && stateRefExists) continue
    (await exists(targetPath(root, relativePath)) ? present : missing).push(relativePath)
  }
  if (storyRefExists) present.push(".harness/PROJECT_STORY_REF.md")
  if (stateRefExists) present.push(".harness/PROJECT_STATE_REF.md")
  let story = null
  const storyPath = targetPath(root, ".harness/PROJECT_STORY.md")
  if (await exists(storyPath)) story = (await readFile(storyPath, "utf8")).slice(0, 5000)
  let storyReference = null
  if (storyRefExists) storyReference = (await readFile(targetPath(root, ".harness/PROJECT_STORY_REF.md"), "utf8")).slice(0, 2000)
  let stateReference = null
  if (stateRefExists) stateReference = (await readFile(targetPath(root, ".harness/PROJECT_STATE_REF.md"), "utf8")).slice(0, 2000)
  return {
    initialized: present.includes(".harness/PROJECT_STORY.md") || present.includes(".harness/PROJECT_STORY_REF.md"),
    present,
    missing,
    story_excerpt: story,
    story_reference_excerpt: storyReference,
    state_reference_excerpt: stateReference,
    next: missing.length ? "Review missing scaffold files; initialize only after explicit owner approval." : storyReference ? "Review the linked canonical project story and current state, then define a finite, owner-approved next Epic." : "Review the project story and define a finite, owner-approved first Epic.",
  }
}

async function findExisting(root, candidates) {
  const found = []
  for (const path of candidates) if (await exists(targetPath(root, path))) found.push(path)
  return found
}
