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

test("resolves local research links and remaps a Harness archive when transferred to another project", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "harness-knowledge-source-project-"))
  const targetRoot = await mkdtemp(join(tmpdir(), "harness-knowledge-target-project-"))
  try {
    await mkdir(join(sourceRoot, "docs", "research"), { recursive: true })
    await writeFile(join(sourceRoot, "docs", "research", "RAW-1.md"), "# RAW-1\n\nEvidence from the source project.\n")
    await writeFile(join(sourceRoot, "docs", "research", "SYN-1.md"), "# Synthesis\n\nSee [RAW-1](RAW-1.md) and DEC-18.\n")
    await writeFile(join(sourceRoot, "docs", "research", "RAW-2.md"), "Disposition: NOT_APPLIED\n\n# Tangential research\n\nRetained but not applied.\n")
    await importProjectKnowledge(sourceRoot, { owner_confirmed: true })

    const sourceIndex = JSON.parse(await readFile(join(sourceRoot, ".harness/knowledge/index.json"), "utf8"))
    const sourceRaw = sourceIndex.records.find((record) => record.source_ref.endsWith("RAW-1.md"))
    const sourceNotApplied = sourceIndex.records.find((record) => record.source_ref.endsWith("RAW-2.md"))
    const sourceSynthesis = sourceIndex.records.find((record) => record.source_ref.endsWith("SYN-1.md"))
    assert.deepEqual(sourceSynthesis.relationships, [sourceRaw.record_key, "DEC-18"])
    assert.deepEqual(sourceSynthesis.unresolved_relationships, ["DEC-18"])
    assert.equal(sourceNotApplied.disposition, "NOT_APPLIED")
    await assert.rejects(importProjectKnowledge(targetRoot, {
      owner_confirmed: true,
      source_project_root: sourceRoot,
    }), /needs a stable source_project_id/)

    const transfer = await importProjectKnowledge(targetRoot, {
      owner_confirmed: true,
      source_project_root: sourceRoot,
      source_project_id: "llm-learning",
    })
    assert.equal(transfer.imported, 3)
    assert.equal(transfer.source_project_id, "llm-learning")
    const targetIndex = JSON.parse(await readFile(join(targetRoot, ".harness/knowledge/index.json"), "utf8"))
    const targetRaw = targetIndex.records.find((record) => record.source_record_key === sourceRaw.record_key)
    const targetNotApplied = targetIndex.records.find((record) => record.source_record_key === sourceNotApplied.record_key)
    const targetSynthesis = targetIndex.records.find((record) => record.source_record_key === sourceSynthesis.record_key)
    assert.notEqual(targetRaw.record_key, sourceRaw.record_key)
    assert.deepEqual(targetSynthesis.relationships, [targetRaw.record_key, "DEC-18"])
    assert.deepEqual(targetSynthesis.unresolved_relationships, ["DEC-18"])
    assert.equal(targetNotApplied.disposition, "NOT_APPLIED")
    assert.equal(await readFile(join(targetRoot, targetRaw.archive_path), "utf8"), "# RAW-1\n\nEvidence from the source project.\n")

    const repeated = await importProjectKnowledge(targetRoot, {
      owner_confirmed: true,
      source_project_root: sourceRoot,
      source_project_id: "llm-learning",
    })
    assert.equal(repeated.imported, 0)
    assert.equal(repeated.unchanged, 3)
  } finally {
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(targetRoot, { recursive: true, force: true })
  }
})

test("serializes concurrent imports so neither index update is lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-knowledge-concurrent-"))
  const source = (id) => ({
    source_id: id,
    title: `Decision ${id}`,
    source_system: "github",
    source_ref: `github:owner/repo/${id}`,
    source_revision: "rev-1",
    classification: "REFERENCE",
    declared_authority: "UNKNOWN",
    content: `Content for ${id}`,
  })
  try {
    await Promise.all([
      importProjectKnowledge(root, { owner_confirmed: true, external_sources: [source("DOC-1")] }),
      importProjectKnowledge(root, { owner_confirmed: true, external_sources: [source("DOC-2")] }),
      recordKnowledgeArtifact(root, {
        artifact_type: "raw-research", artifact_id: "RAW-1", title: "Raw capture 1", content: "Source one.",
        status: "RAW", source_refs: ["https://example.org/source/1"], owner_confirmed: true,
      }),
      recordKnowledgeArtifact(root, {
        artifact_type: "raw-research", artifact_id: "RAW-2", title: "Raw capture 2", content: "Source two.",
        status: "RAW", source_refs: ["https://example.org/source/2"], owner_confirmed: true,
      }),
    ])
    const index = JSON.parse(await readFile(join(root, ".harness/knowledge/index.json"), "utf8"))
    assert.deepEqual(index.records.map((record) => record.source_id).sort(), ["DOC-1", "DOC-2", "RAW-1", "RAW-2"])
    assert.equal(await readdir(join(root, ".harness/knowledge")).then((files) => files.includes("index.lock")), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("preserves binary snapshots byte-for-byte and identifies them as non-text", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-knowledge-binary-"))
  const targetRoot = await mkdtemp(join(tmpdir(), "harness-knowledge-binary-target-"))
  try {
    await mkdir(join(root, "docs", "research", "raw"), { recursive: true })
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a])
    await writeFile(join(root, "docs", "research", "raw", "scan.pdf"), bytes)
    await importProjectKnowledge(root, { owner_confirmed: true })
    const index = JSON.parse(await readFile(join(root, ".harness/knowledge/index.json"), "utf8"))
    const record = index.records[0]
    assert.equal(record.media_type, "binary-preserved")
    assert.deepEqual(await readFile(join(root, record.archive_path)), bytes)
    assert.equal((await readProjectKnowledge(root, record.record_key)).status, "BINARY_SOURCE")
    await importProjectKnowledge(targetRoot, { owner_confirmed: true, source_project_root: root, source_project_id: "binary-source" })
    const targetIndex = JSON.parse(await readFile(join(targetRoot, ".harness/knowledge/index.json"), "utf8"))
    const targetRecord = targetIndex.records.find((item) => item.source_record_key === record.record_key)
    assert.deepEqual(await readFile(join(targetRoot, targetRecord.archive_path)), bytes)
    assert.equal((await readProjectKnowledge(targetRoot, targetRecord.record_key)).status, "BINARY_SOURCE")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(targetRoot, { recursive: true, force: true })
  }
})

test("rejects unsafe transferred record keys before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-knowledge-bad-source-key-"))
  try {
    await assert.rejects(importProjectKnowledge(root, {
      owner_confirmed: true,
      external_sources: [{
        source_id: "DOC-1", source_record_key: "../../outside", title: "Document", source_system: "github",
        source_ref: "github:owner/repo/doc", source_revision: "rev-1", classification: "REFERENCE",
        declared_authority: "UNKNOWN", content: "A source document.",
      }],
    }), /source_record_key must be an exact source-project record key/)
    assert.deepEqual(await readdir(root), [])
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

test("records Epic and WU contracts in their canonical folders and resolves safe local source references", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-knowledge-governance-artifacts-"))
  try {
    await mkdir(join(root, ".harness"), { recursive: true })
    await writeFile(join(root, ".harness", "PROJECT_STORY.md"), "Approved Workshop Waitlist story.\n")
    await writeFile(join(root, ".harness", "IMPORT_ASSESSMENT.md"), "Owner approved one Epic and four WUs.\n")
    const epic = await recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: "E01", title: "Workshop Waitlist",
      content: "Finite Epic contract.", status: "DRAFT",
      source_refs: [".harness/PROJECT_STORY.md", ".harness/IMPORT_ASSESSMENT.md"], owner_confirmed: true,
    })
    assert.equal(epic.path, ".harness/epics/E01.md")
    assert.match(await readFile(join(root, epic.path), "utf8"), /Finite Epic contract/)

    const wu = await recordKnowledgeArtifact(root, {
      artifact_type: "work-unit", artifact_id: "WU-01", title: "Accessible capacity view",
      content: "One bounded outcome.", status: "DRAFT",
      parent_refs: [epic.record_key], source_refs: [".harness/IMPORT_ASSESSMENT.md"], owner_confirmed: true,
    })
    assert.equal(wu.path, ".harness/work-units/WU-01.md")
    assert.match(await readFile(join(root, wu.path), "utf8"), /One bounded outcome/)
    const index = JSON.parse(await readFile(join(root, ".harness/knowledge/index.json"), "utf8"))
    assert.deepEqual(index.records.map((record) => record.source_id).sort(), ["E01", "WU-01"])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("rejects missing or unsafe local artifact source references", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-knowledge-local-ref-safety-"))
  try {
    await writeFile(join(root, "outside.md"), "outside project")
    await assert.rejects(recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: "E01", title: "Unsafe", content: "No write.",
      status: "DRAFT", source_refs: ["../outside.md"], owner_confirmed: true,
    }), /source_ref \.\.\/outside\.md is not present/)
    await assert.rejects(recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: "E01", title: "Missing", content: "No write.",
      status: "DRAFT", source_refs: [".harness/MISSING.md"], owner_confirmed: true,
    }), /source_ref \.harness\/MISSING\.md is not present/)
    assert.deepEqual(await readdir(root), ["outside.md"])
  } finally { await rm(root, { recursive: true, force: true }) }
})
