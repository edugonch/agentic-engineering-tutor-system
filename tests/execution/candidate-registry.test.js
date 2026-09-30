import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureBaseSnapshot, freezeCandidate } from "../../src/execution/candidate.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { disposeWorkspace, materializeCandidate } from "../../src/execution/verification-workspace.js"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-registry-"))
  await writeFile(join(root, "package.json"), "{}\n")
  await writeFile(join(root, "app.js"), "app content\n")
  const base = await captureBaseSnapshot(root, ["package.json"])
  const candidate = await freezeCandidate(root, { base, paths: ["app.js"] })
  const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })
  return { root, candidate, registry }
}

test("stores and loads a candidate that materializes identically", async () => {
  const { root, candidate, registry } = await fixture()
  try {
    const stored = await registry.store(candidate)
    assert.equal(stored.status, "STORED")

    const loaded = await registry.load(candidate.candidate_id)
    assert.equal(loaded.candidate_id, candidate.candidate_id)
    assert.equal(loaded.tree_hash, candidate.tree_hash)
    assert.equal(loaded.manifest_hash, candidate.manifest_hash)

    const { workspace } = await materializeCandidate(loaded)
    assert.equal(await readFile(join(workspace, "package.json"), "utf8"), "{}\n")
    assert.equal(await readFile(join(workspace, "app.js"), "utf8"), "app content\n")
    await disposeWorkspace(workspace)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("re-storing the same candidate is idempotent (REPLAYED)", async () => {
  const { root, candidate, registry } = await fixture()
  try {
    assert.equal((await registry.store(candidate)).status, "STORED")
    assert.equal((await registry.store(candidate)).status, "REPLAYED")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a corrupted blob is rejected on load (BLOB_HASH_MISMATCH)", async () => {
  const { root, candidate, registry } = await fixture()
  try {
    await registry.store(candidate)
    const blobHash = candidate.overlay[0].sha256
    await writeFile(join(registry.blobsDir, blobHash), "corrupted bytes")
    await assert.rejects(registry.load(candidate.candidate_id), /BLOB_HASH_MISMATCH/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a missing candidate returns null", async () => {
  const { root, registry } = await fixture()
  try {
    assert.equal(await registry.load("cand-deadbeef"), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("enforces the file limit before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-registry-lim-"))
  try {
    await writeFile(join(root, "a.txt"), "a\n")
    await writeFile(join(root, "b.txt"), "b\n")
    const candidate = await freezeCandidate(root, { paths: ["a.txt", "b.txt"] })
    const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution"), limits: { maxFiles: 1 } })
    await assert.rejects(registry.store(candidate), /max files/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("deduplicates blobs shared across candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-registry-dedup-"))
  try {
    await writeFile(join(root, "shared.txt"), "shared\n")
    await writeFile(join(root, "a.js"), "a\n")
    await writeFile(join(root, "b.js"), "b\n")
    const base = await captureBaseSnapshot(root, ["shared.txt"])
    const ca = await freezeCandidate(root, { base, paths: ["a.js"] })
    const cb = await freezeCandidate(root, { base, paths: ["b.js"] })
    const registry = createCandidateRegistry({ dir: join(root, ".harness", "execution") })
    await registry.store(ca)
    await registry.store(cb) // shared.txt blob already exists → verified, not rewritten
    const sharedBlob = base.files[0].sha256
    assert.equal(await readFile(join(registry.blobsDir, sharedBlob), "utf8"), "shared\n")
  } finally { await rm(root, { recursive: true, force: true }) }
})
