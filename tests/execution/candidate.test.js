import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureEntries, freezeCandidate, manifestHash, treeHash } from "../../src/execution/candidate.js"

test("freezes files into a stable, content-addressed candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cand-"))
  try {
    await writeFile(join(root, "a.txt"), "hello a\n")
    await writeFile(join(root, "b.txt"), "hello b\n")
    const result = await freezeCandidate(root, { paths: ["a.txt", "b.txt"] })
    assert.match(result.candidate_id, /^cand-/)
    assert.equal(result.manifest_hash.length, 64)
    assert.equal(result.tree_hash.length, 64)
    assert.deepEqual(result.entries.map((e) => e.path), ["a.txt", "b.txt"])
    for (const entry of result.entries) {
      assert.equal(entry.type, "file")
      assert.match(entry.mode, /^100(644|755)$/)
      assert.equal(entry.sha256.length, 64)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a single-byte change yields a different candidate identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cand-byte-"))
  try {
    await writeFile(join(root, "a.txt"), "line one\n")
    const first = await freezeCandidate(root, { paths: ["a.txt"] })
    await writeFile(join(root, "a.txt"), "line one!\n") // one byte changed
    const second = await freezeCandidate(root, { paths: ["a.txt"] })
    assert.notEqual(first.tree_hash, second.tree_hash)
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
    await assert.rejects(
      freezeCandidate(root, { paths: ["leak.txt"] }),
      /symlink escapes the repository/,
    )
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test("a symlink inside the repo is captured as a symlink without following", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cand-link-"))
  try {
    await writeFile(join(root, "target.txt"), "target content\n")
    await symlink("target.txt", join(root, "link.txt"))
    const result = await freezeCandidate(root, { paths: ["link.txt"] })
    const entry = result.entries[0]
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
  const base = { base: null, deletions: [], entries: [{ path: "a.txt", type: "file", mode: "100644", sha256: "x".repeat(64) }] }
  assert.equal(
    manifestHash({ ...base, captured_at: "2026-01-01T00:00:00.000Z" }),
    manifestHash({ ...base, captured_at: "2026-02-02T00:00:00.000Z" }),
  )
})

test("deletions are recorded and deduplicated in the manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-cand-del-"))
  try {
    await writeFile(join(root, "a.txt"), "kept\n")
    const result = await freezeCandidate(root, { paths: ["a.txt"], deletions: ["gone.txt", "gone.txt"] })
    assert.deepEqual(result.manifest.deletions, ["gone.txt"])
  } finally { await rm(root, { recursive: true, force: true }) }
})
