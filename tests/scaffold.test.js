import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
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
    assert.ok(result.created.includes(".opencode/agents/harness-designer.md"))
    assert.ok(result.created.includes(".opencode/skills/architecture-decision/SKILL.md"))
    assert.ok(result.created.includes(".opencode/skills/reference-library-search/SKILL.md"))
    assert.ok(result.created.includes(".harness/references/ENGINEERING-KNOWLEDGE.md"))
    assert.ok(result.created.includes(".harness/templates/ADR.md"))
    assert.ok(result.created.includes(".harness/OPENCODE-CONFIG-FRAGMENT.jsonc"))
    assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "Owner-authored rules\n")
    const story = await readFile(join(root, ".harness/PROJECT_STORY.md"), "utf8")
    assert.match(story, /Sample Project/)
    assert.match(story, /Teams lose project context\./)
    assert.match(await readFile(join(root, ".opencode/skills/architecture-decision/SKILL.md"), "utf8"), /quality scenarios/)
    assert.match(await readFile(join(root, ".opencode/agents/harness-designer.md"), "utf8"), /product-interface designer/)
    assert.match(await readFile(join(root, ".harness/references/ENGINEERING-KNOWLEDGE.md"), "utf8"), /Chip Huyen/)
    assert.match(await readFile(join(root, ".harness/templates/ADR.md"), "utf8"), /Verification plan and evidence/)
    const modelConfig = await readFile(join(root, ".harness/OPENCODE-CONFIG-FRAGMENT.jsonc"), "utf8")
    assert.match(modelConfig, /"model": "provider\/orchestrator-model-id"/)
    for (const agent of ["builder", "researcher", "designer", "reviewer"]) {
      assert.match(modelConfig, new RegExp(`"harness-${agent}"`))
      assert.match(modelConfig, new RegExp(`provider/${agent}-model-id`))
    }
    assert.match(result.openCodeConfig, /opencode models/)
    assert.equal((await getProjectStatus(root)).initialized, true)

    const second = await initializeProject(root, { ...input, project_name: "Changed" })
    assert.ok(second.skipped.includes(".harness/PROJECT_STORY.md"))
    assert.match(await readFile(join(root, ".harness/PROJECT_STORY.md"), "utf8"), /Sample Project/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("governance_only initializes project and Epic/WU governance without support agents, skills, or config", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-governance-only-"))
  try {
    await writeFile(join(root, ".opencode-placeholder"), "existing project file")
    const result = await initializeProject(root, { ...input, initialization_scope: "governance_only" })
    assert.equal(result.initialization_scope, "governance_only")
    assert.deepEqual(result.created.sort(), [
      ".harness/PROJECT_CHARTER.md",
      ".harness/PROJECT_STATE.md",
      ".harness/PROJECT_STORY.md",
      ".harness/epics/README.md",
      ".harness/templates/EPIC.md",
      ".harness/templates/WORK_UNIT.md",
      ".harness/work-units/README.md",
    ].sort())
    assert.equal(result.created.some((path) => path.startsWith(".opencode/")), false)
    assert.equal(result.created.includes(".harness/OPENCODE-CONFIG-FRAGMENT.jsonc"), false)
    assert.equal(result.openCodeConfig, "not created; governance_only scope excludes OpenCode configuration")
    const status = await getProjectStatus(root)
    assert.equal(status.governance_initialized, true)
    assert.ok(status.full_scaffold_missing.includes(".opencode/agents/harness-builder.md"))
    assert.match(status.next, /governance_only initialization/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects unknown initialization scopes before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-invalid-scope-"))
  try {
    await assert.rejects(initializeProject(root, { ...input, initialization_scope: "agents_only" }), /initialization_scope must be/)
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("leaves an existing OpenCode model configuration untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-opencode-config-"))
  const config = '{"model":"owner/provider-model","agents":{"harness-builder":{"model":"owner/builder"}}}\n'
  try {
    await writeFile(join(root, "opencode.jsonc"), config)
    const result = await initializeProject(root, input)
    assert.equal(await readFile(join(root, "opencode.jsonc"), "utf8"), config)
    assert.equal(result.openCodeConfig, "left unchanged (opencode.jsonc already exists)")
    assert.ok(result.created.includes(".harness/OPENCODE-CONFIG-FRAGMENT.jsonc"))
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

test("references existing story and state authorities instead of creating duplicate copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-existing-authority-"))
  try {
    await writeFile(join(root, "PROJECT_STATE.md"), "Canonical state from owner\n")
    const result = await initializeProject(root, {
      ...input,
      project_type: "existing",
      import_assessment: "Verified mapping.",
      project_story_ref: "google-drive:STORY-ID@revision-2",
    })
    assert.equal(result.authority_references.project_state, "PROJECT_STATE.md")
    assert.equal(result.authority_references.project_story, "google-drive:STORY-ID@revision-2")
    assert.equal(result.created.includes(".harness/PROJECT_STATE.md"), false)
    assert.equal(result.created.includes(".harness/PROJECT_STORY.md"), false)
    assert.match(await readFile(join(root, ".harness/PROJECT_STATE_REF.md"), "utf8"), /PROJECT_STATE.md/)
    assert.match(await readFile(join(root, ".harness/PROJECT_STORY_REF.md"), "utf8"), /STORY-ID@revision-2/)
    assert.equal(await readFile(join(root, "PROJECT_STATE.md"), "utf8"), "Canonical state from owner\n")
    assert.equal((await getProjectStatus(root)).initialized, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("stops before writing when multiple state authorities have not been mapped", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ambiguous-authority-"))
  try {
    await mkdir(join(root, "docs", "product"), { recursive: true })
    await writeFile(join(root, "PROJECT_STATE.md"), "State A")
    await writeFile(join(root, "docs", "product", "PROJECT_STATE.md"), "State B")
    await assert.rejects(initializeProject(root, {
      ...input, project_type: "existing", import_assessment: "Owner-approved mapping.",
    }), /multiple state authority candidates/)
    assert.deepEqual(await readdir(root), ["PROJECT_STATE.md", "docs"])
  } finally { await rm(root, { recursive: true, force: true }) }
})
