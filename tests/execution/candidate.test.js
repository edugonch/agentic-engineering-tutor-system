import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureBaseSnapshot, captureEntries, freezeCandidate, manifestHash, treeHash } from "../../src/execution/candidate.js"

test("freezes a complete candidate with all identity layers", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cand-"))
  try {
    await writeFile(join(root, "app.js"), "app content\n")
    const result = await freezeCandidate(root, { paths: ["app.js"] })
    assert.match(result.candidate_id, /^cand-/)
    assert.equal(result.manifest_hash.length, 64)
    assert.equal(result.overlay_hash.length, 64)
    assert.equal(result.tree_hash.length, 64)
    assert.deepEqual(result.overlay.map((e) => e.path), ["app.js"])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("same overlay, different base → different candidate_id (acceptance 1)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cand-base-"))
  try {
    await writeFile(join(root, "app.js"), "app\n")
    const baseA = { kind: "snapshot", commit: "aaaaaaaa", files: [] }
    const baseB = { kind: "snapshot", commit: "bbbbbbbb", files: [] }
    const a = await freezeCandidate(root, { base: baseA, paths: ["app.js"] })
    const b = await freezeCandidate(root, { base: baseB, paths: ["app.js"] })
    assert.equal(a.overlay_hash, b.overlay_hash) // identical changed material
    assert.notEqual(a.manifest_hash, b.manifest_hash)
    assert.notEqual(a.candidate_id, b.candidate_id)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("same overlay, different deletion → different candidate_id (acceptance 2)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cand-del-"))
  try {
    await writeFile(join(root, "app.js"), "app\n")
    const a = await freezeCandidate(root, { paths: ["app.js"], deletions: ["old-a.js"] })
    const b = await freezeCandidate(root, { paths: ["app.js"], deletions: ["old-b.js"] })
    assert.equal(a.overlay_hash, b.overlay_hash)
    assert.notEqual(a.manifest_hash, b.manifest_hash)
    assert.notEqual(a.candidate_id, b.candidate_id)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a single-byte overlay change yields a different candidate identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cand-byte-"))
  try {
    await writeFile(join(root, "a.txt"), "line one\n")
    const first = await freezeCandidate(root, { paths: ["a.txt"] })
    await writeFile(join(root, "a.txt"), "line one!\n")
    const second = await freezeCandidate(root, { paths: ["a.txt"] })
    assert.notEqual(first.tree_hash, second.tree_hash)
    assert.notEqual(first.overlay_hash, second.overlay_hash)
    assert.notEqual(first.candidate_id, second.candidate_id)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a symlink escaping the repo fails closed", async () => {
  const parent = await mkdtemp(join(tmpdir(), "harness-cand-escape-"))
  const root = join(parent, "repo")
  await mkdir(root)
  const outside = join(parent, "outside.txt")
  await writeFile(outside, "secret\n")
  try {
    await symlink(outside, join(root, "leak.txt"))
    await assert.rejects(freezeCandidate(root, { paths: ["leak.txt"] }), /symlink escapes the repository/)
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test("a symlink inside the repo is captured as a symlink without following", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cand-link-"))
  try {
    await writeFile(join(root, "target.txt"), "target content\n")
    await symlink("target.txt", join(root, "link.txt"))
    const result = await freezeCandidate(root, { paths: ["link.txt"] })
    const entry = result.overlay[0]
    assert.equal(entry.type, "symlink")
    assert.equal(entry.target, "target.txt")
    assert.equal(entry.sha256, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("capture re-check detects a changed path (freeze-race primitive)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cand-race-"))
  try {
    await writeFile(join(root, "a.txt"), "v1\n")
    const before = treeHash(await captureEntries(root, ["a.txt"]))
    await writeFile(join(root, "a.txt"), "v2\n")
    const after = treeHash(await captureEntries(root, ["a.txt"]))
    assert.notEqual(before, after)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("manifest identity excludes the capture timestamp", () => {
  const base = { base: { kind: "snapshot", commit: null, files: [] }, deletions: [], overlay: [{ path: "a.txt", type: "file", mode: "100644", sha256: "x".repeat(64) }] }
  assert.equal(
    manifestHash({ ...base, captured_at: "2026-01-01T00:00:00.000Z" }),
    manifestHash({ ...base, captured_at: "2026-02-02T00:00:00.000Z" }),
  )
})

test("deletions are recorded and deduplicated", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cand-dedup-"))
  try {
    await writeFile(join(root, "a.txt"), "kept\n")
    const result = await freezeCandidate(root, { paths: ["a.txt"], deletions: ["gone.txt", "gone.txt"] })
    assert.deepEqual(result.deletions, ["gone.txt"])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("captureBaseSnapshot returns a base with frozen content", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cand-snap-"))
  try {
    await writeFile(join(root, "pkg.json"), "{}\n")
    const base = await captureBaseSnapshot(root, ["pkg.json"])
    assert.equal(base.kind, "snapshot")
    assert.equal(base.files[0].path, "pkg.json")
    assert.ok(base.files[0].content)
  } finally { await rm(root, { recursive: true, force: true }) }
})
