import test from "node:test"
import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureBaseSnapshot, freezeCandidate } from "../../src/execution/candidate.js"
import { disposeWorkspace, materializeCandidate } from "../../src/execution/verification-workspace.js"

test("base files are materialized alongside the overlay (acceptance 3)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ws-base-"))
  try {
    await writeFile(join(root, "package.json"), "{}\n") // unchanged → base
    await writeFile(join(root, "app.js"), "app content\n") // modified → overlay
    const base = await captureBaseSnapshot(root, ["package.json"])
    const candidate = await freezeCandidate(root, { base, paths: ["app.js"] })

    const { workspace } = await materializeCandidate(candidate)
    assert.equal(await readFile(join(workspace, "package.json"), "utf8"), "{}\n")
    assert.equal(await readFile(join(workspace, "app.js"), "utf8"), "app content\n")
    await disposeWorkspace(workspace)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("base + deletion + overlay → tree_hash matches the complete tree (acceptance 4)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ws-complete-"))
  try {
    await writeFile(join(root, "package.json"), "{}\n") // base
    await writeFile(join(root, "old.js"), "old\n") // base, to be deleted
    await writeFile(join(root, "app.js"), "app\n") // overlay
    const base = await captureBaseSnapshot(root, ["package.json", "old.js"])
    const candidate = await freezeCandidate(root, { base, paths: ["app.js"], deletions: ["old.js"] })

    const { workspace, verified, tree_hash } = await materializeCandidate(candidate)
    assert.equal(verified, true)
    assert.equal(tree_hash, candidate.tree_hash)
    assert.equal(await readFile(join(workspace, "package.json"), "utf8"), "{}\n")
    assert.equal(await readFile(join(workspace, "app.js"), "utf8"), "app\n")
    await assert.rejects(access(join(workspace, "old.js"))) // deletion applied
    await disposeWorkspace(workspace)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a working-tree change after freeze does not contaminate the materialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ws-contam-"))
  try {
    await writeFile(join(root, "app.js"), "frozen v1\n")
    const candidate = await freezeCandidate(root, { paths: ["app.js"] })

    await writeFile(join(root, "app.js"), "mutated v2\n") // working tree changes after freeze

    const { workspace } = await materializeCandidate(candidate)
    assert.equal(await readFile(join(workspace, "app.js"), "utf8"), "frozen v1\n")
    await disposeWorkspace(workspace)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a reconstructed tree hash mismatch fails hard", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ws-mismatch-"))
  try {
    await writeFile(join(root, "app.js"), "good\n")
    const candidate = await freezeCandidate(root, { paths: ["app.js"] })
    // Corrupt the frozen overlay content without touching the recorded hash.
    candidate.overlay[0].content = Buffer.from("corrupted\n").toString("base64")
    await assert.rejects(materializeCandidate(candidate), /tree hash differs/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("delete then overlay re-add materializes the file with new content", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-ws-readd-"))
  try {
    await writeFile(join(root, "old.js"), "v1\n")
    const base = await captureBaseSnapshot(root, ["old.js"])
    await writeFile(join(root, "old.js"), "v2\n") // modified after base capture
    const candidate = await freezeCandidate(root, { base, paths: ["old.js"], deletions: ["old.js"] })

    const { workspace, verified } = await materializeCandidate(candidate)
    assert.equal(verified, true)
    assert.equal(await readFile(join(workspace, "old.js"), "utf8"), "v2\n")
    await disposeWorkspace(workspace)
  } finally { await rm(root, { recursive: true, force: true }) }
})
