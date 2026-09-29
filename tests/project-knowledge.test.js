import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverProjectKnowledge,
  importProjectKnowledge,
  readProjectKnowledge,
  recordKnowledgeArtifact,
  searchProjectKnowledge,
} from "../src/project-knowledge.js"

const hash = (text) => createHash("sha256").update(text).digest("hex")

test("discovers the whole document candidate set without reading contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-knowledge-discover-"))
  try {
    await mkdir(join(root, "docs", "research"), { recursive: true })
    await mkdir(join(root, "docs", "product"), { recursive: true })
    await writeFile(join(root, "AGENTS.md"), "do not expose this body")
    await writeFile(join(root, "docs", "research", "compendium.md"), "compendium")
    await writeFile(join(root, "docs", "product", "SPEC-1.md"), "spec")
    await writeFile(join(root, "package.json"), "{}")
    const result = await discoverProjectKnowledge(root)
    assert.deepEqual(result.documents.map((item) => item.path), ["AGENTS.md", "docs/product/SPEC-1.md", "docs/research/compendium.md"])
    assert.equal(result.counts_by_classification.GOVERNANCE_RULE, 1)
    assert.equal(result.counts_by_classification.SPECIFICATION, 1)
    assert.equal(result.counts_by_classification.RESEARCH_COMPENDIUM, 1)
    assert.equal("content" in result.documents[0], false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("imports local and exact-revision external records, preserves hashes, and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-knowledge-import-"))
  try {
    await mkdir(join(root, "docs", "research"), { recursive: true })
    const raw = "# RAW — Pricing research\n\nA cited finding about pricing.\n"
    await writeFile(join(root, "docs", "research", "RAW-1.md"), raw)
    const externalContent = "# Canonical decision\n\nApproved in the source project.\n"
    const source = {
      source_id: "1C2kpQ1driveid",
      title: "Canonical project state",
      source_system: "google-drive",
      source_ref: "drive:1C2kpQ1driveid",
      source_revision: "revision-2026-09-29-01",
      retrieved_at: "2026-09-29T12:00:00.000Z",
      classification: "PROJECT_STATE",
      declared_authority: "CANONICAL",
      content: externalContent,
      related_sources: ["DEC-18"],
    }
    const first = await importProjectKnowledge(root, { owner_confirmed: true, external_sources: [source] })
    assert.equal(first.imported, 2)
    assert.equal(first.records.every((record) => record.import_status === "SNAPSHOT_UNVERIFIED"), true)
    const index = JSON.parse(await readFile(join(root, ".harness/knowledge/index.json"), "utf8"))
    const localRecord = index.records.find((record) => record.source_system === "filesystem")
    const driveRecord = index.records.find((record) => record.source_system === "google-drive")
    assert.equal(hash(await readFile(join(root, localRecord.archive_path))), localRecord.sha256)
    assert.equal(await readFile(join(root, driveRecord.archive_path), "utf8"), externalContent)
    assert.equal(driveRecord.source_id, source.source_id)
    assert.equal(driveRecord.source_revision, source.source_revision)
    assert.deepEqual(driveRecord.relationships, ["DEC-18"])
    const repeated = await importProjectKnowledge(root, { owner_confirmed: true, external_sources: [source] })
    assert.equal(repeated.imported, 0)
    assert.equal(repeated.unchanged, 2)
    const found = await searchProjectKnowledge(root, "cited finding pricing")
    assert.equal(found.results[0].source_id, localRecord.source_id)
    const read = await readProjectKnowledge(root, driveRecord.record_key)
    assert.equal(read.content, externalContent)
    assert.equal((await discoverProjectKnowledge(root)).documents.some((item) => item.path.startsWith(".harness/knowledge/")), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("requires confirmation and rejects conflicting duplicate source revisions before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-knowledge-safety-"))
  try {
    await writeFile(join(root, "README.md"), "Local docs")
    await assert.rejects(importProjectKnowledge(root, {}), /explicit owner confirmation/)
    assert.deepEqual(await readdir(root), ["README.md"])
    const source = {
      source_id: "DOC-1", title: "Doc", source_system: "github", source_ref: "github:repo/doc",
      source_revision: "rev-1", classification: "REFERENCE", declared_authority: "UNKNOWN", content: "Version A",
    }
    await importProjectKnowledge(root, { owner_confirmed: true, external_sources: [source] })
    await assert.rejects(importProjectKnowledge(root, {
      owner_confirmed: true,
      external_sources: [{ ...source, content: "Version B" }],
    }), /source IDs\/revisions or archive paths conflict/)
    const index = JSON.parse(await readFile(join(root, ".harness/knowledge/index.json"), "utf8"))
    assert.equal(index.records.filter((item) => item.source_id === "DOC-1").length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("keeps updated local research as a new immutable revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-knowledge-revisions-"))
  try {
    await mkdir(join(root, "research"), { recursive: true })
    const path = join(root, "research", "benchmark.md")
    await writeFile(path, "# Benchmark\nOld finding\n")
    await importProjectKnowledge(root, { owner_confirmed: true })
    const before = JSON.parse(await readFile(join(root, ".harness/knowledge/index.json"), "utf8"))
    const oldRecord = before.records[0]
    await writeFile(path, "# Benchmark\nNew finding\n")
    const result = await importProjectKnowledge(root, { owner_confirmed: true })
    assert.equal(result.imported, 1)
    const after = JSON.parse(await readFile(join(root, ".harness/knowledge/index.json"), "utf8"))
    const revisions = after.records.filter((record) => record.source_id === oldRecord.source_id)
    assert.equal(revisions.length, 2)
    assert.notEqual(revisions[0].source_revision, revisions[1].source_revision)
    assert.equal(await readFile(join(root, oldRecord.archive_path), "utf8"), "# Benchmark\nOld finding\n")
    assert.equal(revisions.some((record) => record.archive_path === oldRecord.archive_path), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("records provenance and requires an approved parent for stories", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-knowledge-artifact-"))
  try {
    await assert.rejects(recordKnowledgeArtifact(root, {
      artifact_type: "raw-research", artifact_id: "RAW-0", title: "Unauthorized capture", content: "No write.",
      status: "RAW", source_refs: ["https://example.org/source/rev-3"],
    }), /explicit owner authorization/)
    const raw = await recordKnowledgeArtifact(root, {
      artifact_type: "raw-research", artifact_id: "RAW-1", title: "Source capture", content: "Captured source excerpt.",
      status: "RAW", source_refs: ["https://example.org/source/rev-3"], owner_confirmed: true,
    })
    const synthesis = await recordKnowledgeArtifact(root, {
      artifact_type: "research-synthesis", artifact_id: "SYN-1", title: "Evidence synthesis", content: "The source supports the need.",
      status: "PROPOSED", source_refs: [raw.record_key], owner_confirmed: true,
    })
    await assert.rejects(recordKnowledgeArtifact(root, {
      artifact_type: "user-story", artifact_id: "STORY-1", title: "Story", content: "As a user...",
      status: "PROPOSED", parent_refs: ["REQ-1"], owner_confirmed: true,
    }), /indexed APPROVED requirement or specification/)
    const requirement = await recordKnowledgeArtifact(root, {
      artifact_type: "requirement", artifact_id: "REQ-1", title: "Approved requirement", content: "Need durable sources.",
      status: "APPROVED", source_refs: [synthesis.record_key], owner_confirmed: true,
    })
    assert.equal(requirement.approval_status, "APPROVED")
    const story = await recordKnowledgeArtifact(root, {
      artifact_type: "user-story", artifact_id: "STORY-1", title: "Find prior evidence", content: "As a researcher...",
      status: "PROPOSED", parent_refs: ["REQ-1"], source_refs: [synthesis.record_key], owner_confirmed: true,
    })
    assert.equal(story.status, "RECORDED")
    const body = await readFile(join(root, story.path), "utf8")
    assert.match(body, /parent_refs: \["REQ-1"\]/)
    const index = JSON.parse(await readFile(join(root, ".harness/knowledge/index.json"), "utf8"))
    assert.deepEqual(index.records.map((record) => record.source_id).sort(), ["RAW-1", "REQ-1", "STORY-1", "SYN-1"])
  } finally { await rm(root, { recursive: true, force: true }) }
})
