import { readdir } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "node:path"

const IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "coverage",
  ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv", "target", "Pods",
])
const MAX_DEPTH = 6
const MAX_FILES = 1800
const MAX_REPORTED_PATHS = 80
const MAX_KEY_DOCUMENTS = 80
const KEY_DOCUMENTS = new Set([
  "README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "ARCHITECTURE.md",
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle",
  "PROJECT_STORY.md", "PROJECT_CHARTER.md", "PROJECT_STATE.md",
])
const GOVERNANCE_PATTERN = /(^|\/)(\.harness|governance|epics?|work[-_ ]?units?|decisions?|research|adr)(\/|$)|(^|\/)(AGENTS|CLAUDE|CONTRIBUTING|ARCHITECTURE|PROJECT_STORY|PROJECT_CHARTER|PROJECT_STATE)(\.|\/|$)/i

export async function analyzeExistingProject(projectRoot) {
  if (!projectRoot || !isAbsolute(projectRoot)) throw new Error("OpenCode did not provide an absolute project root.")
  projectRoot = resolve(projectRoot)
  const files = []
  const sourceRoots = new Set()
  let directoriesVisited = 0
  let truncated = false

  async function visit(directory, depth) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === "EACCES" || error.code === "EPERM") return
      throw error
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    directoriesVisited += 1
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true
        break
      }
      const path = join(directory, entry.name)
      const relativePath = relative(projectRoot, path).replaceAll("\\", "/")
      if (entry.isDirectory()) {
        if (depth === 0 && /^(src|app|lib|packages|services|api|frontend|backend|server|client)$/i.test(entry.name)) {
          sourceRoots.add(entry.name)
        }
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(path, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      files.push(relativePath)
    }
  }

  await visit(projectRoot, 0)
  const topLevelFiles = files.filter((path) => !path.includes("/")).sort()
  const allKeyDocuments = files.filter((path) => KEY_DOCUMENTS.has(path.split("/").at(-1))).sort()
  const governanceCandidates = files.filter((path) => GOVERNANCE_PATTERN.test(path)).sort()
  const markers = topLevelFiles.filter((path) => [
    "package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "pyproject.toml", "requirements.txt",
    "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json", "mix.exs",
    "Dockerfile", "docker-compose.yml", "compose.yaml",
  ].includes(path))

  return {
    mode: "read-only-existing-project-assessment",
    project: basename(projectRoot),
    inventory: {
      files_seen: files.length,
      directories_visited: directoriesVisited,
      truncated,
      scan_depth_limit: MAX_DEPTH,
      excluded_directories: [...IGNORED_DIRECTORIES].sort(),
    },
    project_markers: markers,
    likely_source_roots: [...sourceRoots].sort(),
    key_documents: allKeyDocuments.slice(0, MAX_KEY_DOCUMENTS),
    key_documents_truncated: allKeyDocuments.length > MAX_KEY_DOCUMENTS,
    governance_candidates: governanceCandidates.slice(0, MAX_REPORTED_PATHS),
    governance_candidates_truncated: governanceCandidates.length > MAX_REPORTED_PATHS,
    limits: [
      "The inventory reports paths and project markers; it does not read or modify file contents.",
      "The scan skips common generated/dependency directories, follows no symlinks, and stops at its depth/file limits.",
      "Absence from this inventory is not proof that information does not exist outside the scanned areas.",
    ],
    next: "Review project markers and governance candidates; inspect only relevant source-of-truth documents, then propose a project-story and governance mapping for owner approval. Do not write or overwrite project files during assessment.",
  }
}
