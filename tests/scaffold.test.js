import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getProjectStatus, initializeProject } from "../src/scaffold.js"

const input = {
  project_name: "Sample Project",
  problem: "Teams lose project context.",
  desired_outcome: "A reliable project workflow.",
  mvp: "A usable initial workflow.",
  success_evidence: "A project completes its first bounded Epic.",
}

test("initializes missing files and preserves existing owner files", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-scaffold-"))
  try {
    await writeFile(join(root, "AGENTS.md"), "Owner-authored rules\n")
    const result = await initializeProject(root, input)
    assert.equal(result.status, "initialized")
    assert.ok(result.skipped.includes("AGENTS.md"))
    assert.ok(result.created.includes(".opencode/agents/harness-orchestrator.md"))
    assert.ok(result.created.includes(".opencode/skills/architecture-decision/SKILL.md"))
    assert.ok(result.created.includes(".opencode/skills/reference-library-search/SKILL.md"))
    assert.ok(result.created.includes(".harness/references/ENGINEERING-KNOWLEDGE.md"))
    assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "Owner-authored rules\n")
    const story = await readFile(join(root, ".harness/PROJECT_STORY.md"), "utf8")
    assert.match(story, /Sample Project/)
    assert.match(story, /Teams lose project context\./)
    assert.match(await readFile(join(root, ".opencode/skills/architecture-decision/SKILL.md"), "utf8"), /quality scenarios/)
    assert.match(await readFile(join(root, ".harness/references/ENGINEERING-KNOWLEDGE.md"), "utf8"), /Chip Huyen/)
    assert.equal((await getProjectStatus(root)).initialized, true)

    const second = await initializeProject(root, { ...input, project_name: "Changed" })
    assert.ok(second.skipped.includes(".harness/PROJECT_STORY.md"))
    assert.match(await readFile(join(root, ".harness/PROJECT_STORY.md"), "utf8"), /Sample Project/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("records an approved existing-project mapping without replacing an existing report", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-import-"))
  const importInput = {
    ...input,
    project_type: "existing",
    import_assessment: "## Verified story\nExisting application for teams.\n\n## Mapping\nE01 remains historical; propose a new finite chapter.",
  }
  try {
    await writeFile(join(root, ".harness-import-placeholder"), "legacy project marker")
    const result = await initializeProject(root, importInput)
    assert.ok(result.created.includes(".harness/IMPORT_ASSESSMENT.md"))
    const report = await readFile(join(root, ".harness/IMPORT_ASSESSMENT.md"), "utf8")
    assert.match(report, /Owner-approved mapping recorded/)
    assert.match(report, /E01 remains historical/)

    const changed = await initializeProject(root, { ...importInput, import_assessment: "Replacement" })
    assert.ok(changed.skipped.includes(".harness/IMPORT_ASSESSMENT.md"))
    assert.match(await readFile(join(root, ".harness/IMPORT_ASSESSMENT.md"), "utf8"), /E01 remains historical/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects an existing-project import without an approved assessment before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-import-incomplete-"))
  try {
    await assert.rejects(initializeProject(root, { ...input, project_type: "existing" }), /owner-approved import_assessment/)
    assert.deepEqual(await (await import("node:fs/promises")).readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
