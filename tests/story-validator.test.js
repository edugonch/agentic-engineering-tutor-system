import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateStoryFile } from "../src/story-validator.js"

const epic = `# E01\n## Chapter purpose\ntext\n## Start condition\ntext\n## User-visible outcome\ntext\n## Terminal demo and acceptance\ntext\n## Approved WU budget\ntext\n## Work Unit sequence\ntext\n## Out of scope\ntext\n`

test("accepts an Epic contract with finite story sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-"))
  try {
    await mkdir(join(root, ".harness", "epics"), { recursive: true })
    await writeFile(join(root, ".harness", "epics", "E01.md"), epic)
    const result = await validateStoryFile(root, ".harness/epics/E01.md", "epic")
    assert.equal(result.status, "PASS")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("does not flag explicit prohibition of recursive WU creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-"))
  try {
    await writeFile(join(root, "WU.md"), `## Story and Epic connection\n## Single outcome\nindivisible outcome\n## Acceptance criteria\ntext\n## Boundaries\ntext\n## Dependencies\nnone\nCHILD_WORK_UNITS_ALLOWED: NO\nDo not create child work units.\n## Stop condition\ntext\n`)
    const result = await validateStoryFile(root, "WU.md", "wu")
    assert.equal(result.status, "PASS")
    assert.deepEqual(result.warnings, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reports missing WU atomicity and recursively generated work", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-"))
  try {
    await writeFile(join(root, "WU.md"), "## Story and Epic connection\n## Single outcome\nCreate a child work unit later.\n")
    const result = await validateStoryFile(root, "WU.md", "wu")
    assert.equal(result.status, "FAIL")
    assert.ok(result.missing_required_sections.includes("acceptance criteria"))
    assert.ok(result.warnings.some((warning) => warning.includes("recursive")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects document paths outside the project", async () => {
  await assert.rejects(() => validateStoryFile("/tmp/project", "../secret.md", "epic"), /escapes the project root/)
})
