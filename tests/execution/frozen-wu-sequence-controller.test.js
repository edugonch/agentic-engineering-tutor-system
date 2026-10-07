import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { runExecutionController } from "../../src/execution/controller-tool.js"

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "harness-frozen-sequence-"))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

async function seedEpic(root, sequence) {
  await recordKnowledgeArtifact(root, {
    artifact_type: "epic",
    artifact_id: "epic-seq",
    title: "Finite Epic",
    content: `finite epic\nexecution_mandate: ${JSON.stringify({
      max_wus: 4,
      total_seconds: 100,
      wu_sequence: sequence,
    })}`,
    status: "APPROVED",
    owner_confirmed: true,
    source_refs: ["https://example.com/epic"],
  })
}

async function seedWu(root, id) {
  await recordKnowledgeArtifact(root, {
    artifact_type: "work-unit",
    artifact_id: id,
    title: id,
    content: "predeclared work unit",
    status: "PROPOSED",
    owner_confirmed: true,
    parent_refs: ["epic-seq"],
  })
}

test("approve_mandate rejects a frozen sequence whose WU artifacts do not already exist", async () => {
  await withRoot(async (root) => {
    await seedEpic(root, ["WU-01", "WU-02"])
    await seedWu(root, "WU-01")
    await assert.rejects(
      runExecutionController(root, {
        action: "approve_mandate",
        execution_id: "E1",
        session_id: "s1",
        epic_artifact_id: "epic-seq",
      }),
      /expected exactly one durable Work Unit artifact for WU-02/,
    )
  })
})

test("approved frozen sequence is stored and enforces first activation identity", async () => {
  await withRoot(async (root) => {
    await seedEpic(root, ["WU-01", "WU-02"])
    await seedWu(root, "WU-01")
    await seedWu(root, "WU-02")

    const approved = await runExecutionController(root, {
      action: "approve_mandate",
      execution_id: "E1",
      session_id: "s1",
      epic_artifact_id: "epic-seq",
    })
    assert.deepEqual(approved.mandate.wu_sequence, ["WU-01", "WU-02"])

    await assert.rejects(
      runExecutionController(root, {
        action: "activate_wu",
        execution_id: "E1",
        session_id: "s1",
        mandate_id: "E1-MANDATE-001",
        wu_id: "WU-02",
      }),
      /next frozen WU is WU-01/,
    )

    const first = await runExecutionController(root, {
      action: "activate_wu",
      execution_id: "E1",
      session_id: "s1",
      mandate_id: "E1-MANDATE-001",
      wu_id: "WU-01",
    })
    assert.equal(first.wu.wu_id, "WU-01")
  })
})
