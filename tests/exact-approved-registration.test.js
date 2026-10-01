import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { recordKnowledgeArtifact, findApprovedEpic } from "../src/project-knowledge.js"
import { recordArtifactWithActivationGate } from "../src/activation-gate.js"

const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const bytes = Buffer.from('# Approved Epic — exact bytes\r\n\r\nexecution_mandate: {"max_wus":1,"total_seconds":1800}\r\n \t\r\n\n')
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-exact-approved-"))
  try {
    await mkdir(join(root, "docs"))
    await writeFile(join(root, "docs/epic.md"), bytes)
    const input = { artifact_type: "epic", artifact_id: "EXACT-EPIC", title: "Index-only title", status: "APPROVED", owner_confirmed: true,
      content_source_path: "docs/epic.md", expected_content_sha256: hash(bytes), source_refs: ["docs/epic.md"] }
    await fn(root, input)
  } finally { await rm(root, { recursive: true, force: true }) }
}
async function noAuthority(root, id = "EXACT-EPIC") {
  await assert.rejects(findApprovedEpic(root, id), /No APPROVED Epic/)
  try {
    const index = JSON.parse(await readFile(join(root, ".harness/knowledge/index.json"), "utf8"))
    assert.equal(index.records.some(r => r.source_id === id && r.declared_authority === "APPROVED"), false)
  } catch (error) { if (error.code !== "ENOENT") throw error }
}

test("exact approved Epic preserves Buffer bytes, trailing whitespace, hashes, index authority and parsed mandate", async () => fixture(async (root, input) => {
  const result = await recordKnowledgeArtifact(root, input)
  const archive = await readFile(join(root, result.path))
  assert.deepEqual(archive, bytes)
  assert.equal(result.sha256, input.expected_content_sha256)
  const index = JSON.parse(await readFile(join(root, ".harness/knowledge/index.json"), "utf8"))
  const record = index.records.find(r => r.source_id === input.artifact_id)
  assert.equal(record.source_revision, hash(archive))
  assert.equal(record.sha256, hash(archive))
  assert.equal(record.byte_size, bytes.length)
  assert.equal(record.declared_title, input.title)
  assert.equal(record.declared_authority, "APPROVED")
  assert.equal(record.import_status, "OWNER_APPROVED_ARTIFACT")
  assert.equal(record.content_source_path, input.content_source_path)
  assert.equal(record.owner_confirmed, true)
  const approved = await findApprovedEpic(root, input.artifact_id)
  assert.equal(approved.source_revision, hash(bytes))
  assert.deepEqual(approved.mandate, { max_wus: 1, total_seconds: 1800 })
  await writeFile(join(root, input.content_source_path), "subsequent unrelated source change")
  assert.deepEqual(await readFile(join(root, result.path)), bytes)
}))

test("wrong exact hash rejects before archive or APPROVED authority is written", async () => fixture(async (root, input) => {
  await assert.rejects(recordKnowledgeArtifact(root, { ...input, expected_content_sha256: "0".repeat(64) }), /hash|SHA256/i)
  await assert.rejects(readFile(join(root, ".harness/epics/EXACT-EPIC.md")), { code: "ENOENT" })
  await noAuthority(root)
}))

test("exact registration rejects unsafe and ambiguous source paths", async () => fixture(async (root, input) => {
  for (const path of ["../epic.md", "docs/../docs/epic.md", "/etc/passwd", "C:\\epic.md", "docs\\epic.md", "docs//epic.md", "./docs/epic.md", "", "docs/epic.md\0"]) {
    await assert.rejects(recordKnowledgeArtifact(root, { ...input, content_source_path: path }), /source|path|relative|traversal/i)
    await noAuthority(root)
  }
}))

test("exact registration rejects final and parent symlinks, directories and missing sources", async () => fixture(async (root, input) => {
  await symlink(join(root, "docs/epic.md"), join(root, "link.md"))
  await symlink(join(root, "docs"), join(root, "linked-docs"))
  for (const path of ["link.md", "linked-docs/epic.md", "docs", "docs/missing.md"]) {
    await assert.rejects(recordKnowledgeArtifact(root, { ...input, content_source_path: path }), /source|symlink|regular|ENOENT/i)
    await noAuthority(root)
  }
}))

test("exact mode requires APPROVED and literal owner confirmation", async () => fixture(async (root, input) => {
  for (const overrides of [{ status: "DRAFT" }, { status: "PROPOSED" }, { owner_confirmed: false }, { owner_confirmed: "true" }, { owner_confirmed: undefined }]) {
    await assert.rejects(recordKnowledgeArtifact(root, { ...input, ...overrides }), /APPROVED|owner/i)
    await noAuthority(root)
  }
}))

test("exact mode rejects missing/malformed digest, missing path and competing model content", async () => fixture(async (root, input) => {
  for (const overrides of [{ expected_content_sha256: undefined }, { expected_content_sha256: "bad" }, { content_source_path: undefined }, { content: "model-generated substitute" }]) {
    await assert.rejects(recordKnowledgeArtifact(root, { ...input, ...overrides }), /source|hash|SHA256|content/i)
    await noAuthority(root)
  }
}))

test("exact artifacts retain exclusive no-overwrite history", async () => fixture(async (root, input) => {
  const first = await recordKnowledgeArtifact(root, input)
  const index = await readFile(join(root, ".harness/knowledge/index.json"))
  await assert.rejects(recordKnowledgeArtifact(root, input), /already exists/)
  assert.deepEqual(await readFile(join(root, first.path)), bytes)
  assert.deepEqual(await readFile(join(root, ".harness/knowledge/index.json")), index)
}))

test("failed exact archive creation creates no usable approved authority", async () => fixture(async (root, input) => {
  await mkdir(join(root, ".harness/epics"), { recursive: true })
  await writeFile(join(root, ".harness/epics/EXACT-EPIC.md"), "prior immutable unindexed artifact")
  await assert.rejects(recordKnowledgeArtifact(root, input), /already exists/)
  await noAuthority(root)
  assert.equal(await readFile(join(root, ".harness/epics/EXACT-EPIC.md"), "utf8"), "prior immutable unindexed artifact")
}))

test("legacy envelope registration preserves its original format and normalization", async () => fixture(async (root) => {
  const input = { artifact_type: "epic", artifact_id: "LEGACY", title: " Legacy title ", content: "legacy body \n\n", status: "APPROVED", owner_confirmed: true, source_refs: ["docs/epic.md"] }
  const result = await recordKnowledgeArtifact(root, input)
  const record = JSON.parse(await readFile(join(root, ".harness/knowledge/index.json"), "utf8")).records[0]
  const expected = ["---", 'artifact_id: "LEGACY"', 'artifact_type: "epic"', 'status: "APPROVED"', `created_at: ${JSON.stringify(record.retrieved_at)}`, 'source_refs: ["docs/epic.md"]', 'parent_refs: []', "---", "", "# Legacy title", "", "legacy body"].join("\n")
  assert.equal(await readFile(join(root, result.path), "utf8"), expected)
  assert.equal(record.source_revision, hash(expected))
}))

test("exact file-backed decisions cannot bypass specialist activation readiness", async () => fixture(async (root, input) => {
  const result = await recordArtifactWithActivationGate(root, { ...input, artifact_type: "decision", artifact_id: "DECISION", title: "Decision from local source" }, { list: async () => ({ data: [] }) }, recordKnowledgeArtifact)
  assert.equal(result.status, "blocked")
  assert.deepEqual(result.files_written, [])
  await assert.rejects(readFile(join(root, ".harness/knowledge/artifacts/decision/DECISION.md")), { code: "ENOENT" })
}))
