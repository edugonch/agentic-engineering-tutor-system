import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { analyzeExistingProject } from "../src/project-analysis.js"

test("creates a bounded, read-only inventory of an existing project", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-import-"))
  try {
    await mkdir(join(root, ".harness", "epics"), { recursive: true })
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "node_modules", "hidden-package"), { recursive: true })
    await writeFile(join(root, "README.md"), "Existing product context")
    await writeFile(join(root, "package.json"), '{"name":"existing-project"}')
    await writeFile(join(root, "src", "index.js"), "export {}")
    await writeFile(join(root, ".harness", "epics", "E01.md"), "An existing chapter")
    await writeFile(join(root, "node_modules", "hidden-package", "README.md"), "Dependency")

    const result = await analyzeExistingProject(root)
    assert.equal(result.mode, "read-only-existing-project-assessment")
    assert.equal(result.project, root.split("/").at(-1))
    assert.deepEqual(result.project_markers, ["package.json"])
    assert.ok(result.likely_source_roots.includes("src"))
    assert.ok(result.key_documents.includes("README.md"))
    assert.ok(result.governance_candidates.includes(".harness/epics/E01.md"))
    assert.ok(!result.governance_candidates.some((path) => path.includes("node_modules")))
    assert.equal(result.inventory.truncated, false)
    assert.ok(result.next.includes("Do not write"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects a non-absolute root instead of guessing a working directory", async () => {
  await assert.rejects(analyzeExistingProject("relative/project"), /absolute project root/)
})
