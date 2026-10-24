// Regression: imported Work Units link to the Epic's canonical record_key,
// even when the frozen mandate refers to the Epic by its original source_id.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  importProjectKnowledge, readWorkUnitDefinition, recordKnowledgeArtifact,
} from "../src/project-knowledge.js"

const EPIC = "EPIC-05-APPROVED-2026-10-14-V2"
const WU = "E05-20-E"
const source = (id, classification, related_sources = []) => ({
  source_id: id,
  title: id,
  source_system: "github",
  source_ref: "github:owner/repo/" + id,
  source_revision: "r1",
  classification,
  declared_authority: "UNKNOWN",
  content: "# " + id + "\nFrozen source content\n",
  related_sources,
})
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-epic-linkage-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}
async function loadIndex(root) {
  return JSON.parse(await readFile(join(root, ".harness", "knowledge", "index.json"), "utf8"))
}

test("imported WU resolves Epic source_id to record_key and JIT reader accepts canonical link", async () => {
  await withRoot(async root => {
    await importProjectKnowledge(root, {
      owner_confirmed: true,
      external_sources: [
        source(EPIC, "EPIC"),
        source(WU, "WORK_UNIT", ["https://github.com/owner/repo/issues/200", EPIC]),
      ],
    })
    const index = await loadIndex(root)
    const epic = index.records.find(r => r.source_id === EPIC)
    const wu = index.records.find(r => r.source_id === WU)
    assert.ok(epic)
    assert.ok(wu)
    assert.notEqual(epic.record_key, EPIC)
    assert.ok(wu.source_relationships.includes(EPIC))
    assert.ok(wu.relationships.includes(epic.record_key))
    assert.ok(!wu.relationships.includes(EPIC))

    const resolved = await readWorkUnitDefinition(root, WU, EPIC)
    assert.match(resolved.content, /Frozen source content/)
    assert.equal(resolved.source_record_key, wu.record_key)
    assert.equal(resolved.source_hash, wu.sha256)

    const byCanonicalId = await readWorkUnitDefinition(root, WU, epic.record_key)
    assert.equal(byCanonicalId.source_record_key, wu.record_key)
  })
})

test("JIT reader rejects missing or unrelated Epic links", async () => {
  await withRoot(async root => {
    const unrelatedEpic = "EPIC-OTHER"
    await importProjectKnowledge(root, {
      owner_confirmed: true,
      external_sources: [
        source(EPIC, "EPIC"),
        source(unrelatedEpic, "EPIC"),
        source(WU, "WORK_UNIT", [unrelatedEpic]),
      ],
    })
    await assert.rejects(
      readWorkUnitDefinition(root, WU, EPIC),
      /WU contract must be linked to the approved Epic/,
    )
    await assert.rejects(
      readWorkUnitDefinition(root, WU, "EPIC-UNKNOWN"),
      /WU contract must be linked to the approved Epic/,
    )
  })
})

test("legacy direct source_id links remain valid without conferring approval", async () => {
  await withRoot(async root => {
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: EPIC, title: "Approved Epic",
      content: "Epic contract.", status: "DRAFT", owner_confirmed: true,
    })
    await recordKnowledgeArtifact(root, {
      artifact_type: "work-unit", artifact_id: WU, title: "Work Unit",
      content: "Unapproved contract.", status: "DRAFT",
      parent_refs: [EPIC], owner_confirmed: true,
    })
    const result = await readWorkUnitDefinition(root, WU, EPIC)
    assert.match(result.content, /Unapproved contract/)
    await assert.rejects(
      readWorkUnitDefinition(root, WU, EPIC, WU, { requireApproved: true }),
      /Contract correction requires an APPROVED WU source/,
    )
  })
})
