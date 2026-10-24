import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readWorkUnitDefinition, recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import {
  compileMandateDerivedWu, isPlanningWuSource, isTechnicalWuContractBlocker,
} from "../../src/execution/jit-contract.js"

const EPIC = "EPIC-05-APPROVED-2026-10-14-V2"
const WU = "E05-20-E"
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const narrative = [
  "---",
  "narrative_id: E05-20",
  "epic: EPIC-05",
  "status: DRAFT (planning; non-executable)",
  "---",
  "# Historial append-only",
  "Salida comprobable: test de inserción.",
  "Expected write scope: scheduling/ persistencia.",
].join("\n")

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-planning-drift-"))
  try {
    await writeFile(join(root, "README.md"), "Project description.\n")
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }))
    await recordKnowledgeArtifact(root, {
      artifact_type: "epic", artifact_id: EPIC, title: "Approved Epic",
      status: "APPROVED", content: "Frozen Epic.", source_refs: ["README.md"],
      owner_confirmed: true,
    })
    await recordKnowledgeArtifact(root, {
      artifact_type: "work-unit", artifact_id: WU, title: "Work Unit",
      status: "APPROVED", content: narrative, parent_refs: [EPIC],
      owner_confirmed: true,
    })
    const path = join(root, ".harness", "work-units", WU + ".md")
    const indexedBytes = await readFile(path)
    return await fn({ root, path, indexedBytes })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("JIT permits audited drift in an unactivated WU without rewriting indexed authority", async () => {
  await withRoot(async ({ root, path, indexedBytes }) => {
    const modified = Buffer.from(indexedBytes.toString("utf8") + "\nSmall planning clarification.\n")
    await writeFile(path, modified)
    await assert.rejects(readWorkUnitDefinition(root, WU, EPIC), /integrity mismatch/)
    await assert.rejects(
      readWorkUnitDefinition(root, WU, EPIC, WU, { requireApproved: true, allowPlanningDrift: true }),
      /integrity mismatch/,
    )
    const source = await readWorkUnitDefinition(root, WU, EPIC, WU, { allowPlanningDrift: true })
    assert.equal(source.source_hash, hash(modified))
    assert.equal(source.indexed_source_hash, hash(indexedBytes))
    assert.equal(source.source_integrity, "UNACTIVATED_PLANNING_DRIFT")
    assert.equal(source.source_revision, hash(modified))
    assert.ok(isPlanningWuSource(source.content))
    const index = JSON.parse(await readFile(join(root, ".harness/knowledge/index.json"), "utf8"))
    assert.equal(index.records.find(r => r.source_id === WU).sha256, hash(indexedBytes))

    const state = {
      time_policy: { mode: "WU_PLANNING_ESTIMATES" },
      mandate: { wu_sequence: [WU], source_hash: "a".repeat(64) },
      activated_wu_ids: [], wu: null, dispatches: {},
      budget: { total_seconds: 120, used_seconds: 0, active_phase: null },
    }
    const contract = await compileMandateDerivedWu(root, state, WU, source)
    assert.equal(contract.source_authority, "MANDATE_DERIVED")
    assert.equal(contract.origin_source_hash, hash(modified))
    assert.equal(contract.indexed_source_hash, hash(indexedBytes))
    assert.equal(contract.active_seconds, 120)
    assert.equal(contract.source_content, source.content)
  })
})

test("UNKNOWN indexed planning record accepts approved wrapper with embedded draft without elevating authority", async () => {
  await withRoot(async ({ root, path }) => {
    // Recreate the ALFRAN discrepancy: the knowledge index was registered
    // while the WU was DRAFT, but its live artifact now says APPROVED on the
    // outside and DRAFT (planning; non-executable) in the narrative.
    const indexPath = join(root, ".harness/knowledge/index.json")
    const index = JSON.parse(await readFile(indexPath, "utf8"))
    const original = index.records.find(record => record.source_id === WU)
    assert.equal(original.declared_authority, "APPROVED")
    const draftOuter = (await readFile(path, "utf8")).replace(
      'status: "APPROVED"', 'status: "DRAFT"')
    // Only test setup simulates a historical DRAFT registration; production
    // does not rewrite the knowledge index or historical hashes.
    const oldHash = hash(Buffer.from(draftOuter))
    original.declared_authority = "UNKNOWN"
    original.import_status = "RECORDED_ARTIFACT"
    original.sha256 = oldHash
    original.source_revision = oldHash
    original.byte_size = Buffer.byteLength(draftOuter)
    await writeFile(indexPath, JSON.stringify(index) + "\n")
    const current = await readFile(path)
    assert.notEqual(hash(current), oldHash)
    assert.match(current.toString("utf8"), /status: "APPROVED"/)
    assert.match(current.toString("utf8"), /status: DRAFT \(planning; non-executable\)/)

    await assert.rejects(
      readWorkUnitDefinition(root, WU, EPIC),
      /integrity mismatch/,
    )
    await assert.rejects(
      readWorkUnitDefinition(root, WU, EPIC, WU,
        { allowPlanningDrift: true, requireApproved: true }),
      /Contract correction requires an APPROVED WU source/,
    )
    const source = await readWorkUnitDefinition(root, WU, EPIC, WU,
      { allowPlanningDrift: true })
    assert.equal(source.source_integrity, "UNACTIVATED_PLANNING_DRIFT")
    assert.equal(source.indexed_source_hash, oldHash)
    assert.equal(source.source_hash, hash(current))
    assert.ok(isPlanningWuSource(source.content))
    const after = JSON.parse(await readFile(indexPath, "utf8"))
    const indexed = after.records.find(record => record.source_id === WU)
    assert.equal(indexed.declared_authority, "UNKNOWN")
    assert.equal(indexed.sha256, oldHash)

    for (const changed of [
      current.toString("utf8").replace(
        "status: DRAFT (planning; non-executable)",
        "status: APPROVED"),
      current.toString("utf8").replace(
        'status: "APPROVED"', 'status: "REJECTED"'),
      current.toString("utf8").replace(EPIC, "OTHER-EPIC"),
      current.toString("utf8").replace(
        'artifact_id: "E05-20-E"', 'artifact_id: "E05-OTHER"'),
    ]) {
      await writeFile(path, changed)
      await assert.rejects(
        readWorkUnitDefinition(root, WU, EPIC, WU, { allowPlanningDrift: true }),
        /integrity mismatch/,
      )
    }
  })
})

test("planning drift cannot change artifact identity, status or parent authority", async () => {
  await withRoot(async ({ root, path, indexedBytes }) => {
    for (const changed of [
      indexedBytes.toString("utf8").replace('artifact_id: "E05-20-E"', 'artifact_id: "E05-OTHER"'),
      indexedBytes.toString("utf8").replace('status: "APPROVED"', 'status: "REJECTED"'),
      indexedBytes.toString("utf8").replace(EPIC, "EPIC-OTHER"),
      indexedBytes.toString("utf8").replace('artifact_type: "work-unit"', 'artifact_type: "decision"'),
    ]) {
      await writeFile(path, changed)
      await assert.rejects(
        readWorkUnitDefinition(root, WU, EPIC, WU, { allowPlanningDrift: true }),
        /integrity mismatch/,
      )
    }
  })
})

test("planning parser distinguishes approved wrapper, embedded draft and rejected sources", () => {
  assert.equal(isPlanningWuSource([
    "---", 'artifact_id: "E05-20-E"', 'status: "APPROVED"', "---",
    "---", "status: DRAFT (planning; non-executable)", "---",
  ].join("\n")), true)
  assert.equal(isPlanningWuSource([
    "---", 'status: "APPROVED"', "---", "---", "status: APPROVED", "---",
  ].join("\n")), false)
  assert.equal(isPlanningWuSource([
    "---", 'status: "REJECTED"', "---", "---", "status: DRAFT (planning; non-executable)", "---",
  ].join("\n")), false)
  assert.equal(isPlanningWuSource([
    "---", 'status: "DRAFT"', "---", "# Planning",
  ].join("\n")), true)
})

test("only narrowly identified WU checksum tooling blocker can be resolved through JIT", () => {
  assert.equal(isTechnicalWuContractBlocker({
    class: "BLOCKED_TOOLING",
    reason: "Next WU E05-20-E blocked: inspect_next_wu_contract → 'WU contract integrity mismatch'.",
  }), true)
  for (const blocker of [
    { class: "BLOCKED_TOOLING", reason: "CI failure or missing dependencies" },
    { class: "BLOCKED_TOOLING", reason: "WU contract integrity mismatch in an unrelated file" },
    { class: "BLOCKED_SECURITY", reason: "Next WU E05-20-E blocked: WU contract integrity mismatch" },
    { class: "BLOCKED_AUTHORITY", reason: "NOT a WU_CONTRACT_REQUIRED issue" },
  ]) assert.equal(isTechnicalWuContractBlocker(blocker), false)
})
