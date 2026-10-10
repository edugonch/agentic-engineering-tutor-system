import { readFile, realpath } from "node:fs/promises"
import { resolve, relative, isAbsolute } from "node:path"
import { stableHash } from "./execution/serialize.js"

export async function readProjectInstructions(root, paths = ["AGENTS.md", "skills/ROUTER.md"]) {
  const base = await realpath(root)
  const documents = []
  for (const path of [...new Set(paths)]) {
    if (typeof path !== "string" || isAbsolute(path)) throw new Error("Project instruction paths must be relative")
    const target = resolve(base, path)
    const rel = relative(base, target)
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Project instruction path escapes the repository")
    let actual
    try { actual = await realpath(target) } catch (error) {
      if (error.code === "ENOENT" && ["AGENTS.md", "skills/ROUTER.md"].includes(path)) continue
      throw error
    }
    const actualRel = relative(base, actual)
    if (actualRel.startsWith("..") || isAbsolute(actualRel)) throw new Error("Project instruction symlink escapes the repository")
    const content = await readFile(actual, "utf8")
    if (Buffer.byteLength(content) > 262144) throw new Error(`Instruction file too large: ${path}; select a smaller authority slice`)
    documents.push({ path, hash: stableHash(content), content })
  }
  return { documents, fingerprint: stableHash(documents.map(({ path, hash }) => ({ path, hash }))) }
}

export function projectInstructionContext(bundle) {
  if (!bundle.documents.length) return null
  return `Project execution instructions (fingerprint ${bundle.fingerprint}). Follow the applicable AGENTS.md and its router; read PROJECT_STATE.md and only the skills activated by this assignment. Load any deeper AGENTS.md applicable to affected paths. Preserve higher-priority instructions and explicit runtime permissions. Required external reads are distinct from candidate verification: prefer exposed MCP tools; use harness_read_external_source for supported read-only CLI access. Missing CLI alone is not an authority defect; the orchestrator performs permitted bootstrap. A successful connection probe does not prove access to an exact document or complete pagination.\n${bundle.documents.map(d => `--- ${d.path} (${d.hash}) ---\n${d.content}`).join("\n\n")}`
}
