import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { disposeWorkspace, materializeCandidate } from "../../src/execution/verification-workspace.js"

test("materializes a candidate and verifies the tree hash round-trips", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ws-"))
  try {
    await writeFile(join(root, "a.txt"), "content a\n")
    const candidate = await freezeCandidate(root, { paths: ["a.txt"] })
    const { workspace, verified, tree_hash } = await materializeCandidate(candidate)
    assert.equal(verified, true)
    assert.equal(tree_hash, candidate.tree_hash)
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "content a\n")
    await disposeWorkspace(workspace)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a working-tree change after freeze does not contaminate the materialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ws-contam-"))
  try {
    await writeFile(join(root, "a.txt"), "frozen v1\n")
    const candidate = await freezeCandidate(root, { paths: ["a.txt"] })

    await writeFile(join(root, "a.txt"), "mutated v2\n") // working tree changes after freeze

    const { workspace } = await materializeCandidate(candidate)
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "frozen v1\n")
    await disposeWorkspace(workspace)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a reconstructed tree hash mismatch fails hard", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ws-mismatch-"))
  try {
    await writeFile(join(root, "a.txt"), "good\n")
    const candidate = await freezeCandidate(root, { paths: ["a.txt"] })
    // Corrupt the frozen content without touching the recorded hash.
    candidate.entries[0].content = Buffer.from("corrupted\n").toString("base64")
    await assert.rejects(
      materializeCandidate(candidate),
      /tree hash differs/,
    )
  } finally { await rm(root, { recursive: true, force: true }) }
})
