// Content-addressed candidate registry.
//
//   .harness/execution/candidate-blobs/<full-sha256>   raw immutable bytes
//   .harness/execution/candidates/cand-<full-sha256>.json   canonical entry
//
// Properties:
//   - blobs are write-once (`wx`), immutable, and deduplicated by content hash;
//   - existing blobs are verified by hash before being accepted;
//   - limits (files / single blob / total bytes) are checked BEFORE writing;
//   - a re-store of the same candidate_id with the same hashes is idempotent;
//     a different content under the same id raises CANDIDATE_REGISTRY_CONFLICT;
//   - load() re-validates paths, symlink targets, duplicates, and every blob
//     hash, then recomputes manifest_hash/overlay_hash/tree_hash/candidate_id.
//
// load() returns the exact logical contract materializeCandidate() consumes, so
// the runner never needs to know whether a candidate came from memory or disk.

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { assertCandidatePath, composeCandidateEntries, manifestHash, treeHash } from "./candidate.js"

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

const DEFAULT_LIMITS = {
  maxFiles: 1000,
  maxBlobBytes: 10 * 1024 * 1024, // 10 MiB per blob
  maxTotalBytes: 200 * 1024 * 1024, // 200 MiB per candidate
}

function assertNoDuplicatePaths(entries, label) {
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`duplicate ${label} path on load: ${entry.path}`)
    seen.add(entry.path)
  }
}

export function createCandidateRegistry({ dir, limits = {} } = {}) {
  const blobsDir = join(dir, "candidate-blobs")
  const candidatesDir = join(dir, "candidates")
  const { maxFiles, maxBlobBytes, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits }

  const fileEntries = (candidate) => [
    ...(candidate.base?.files ?? []),
    ...(candidate.overlay ?? []),
  ].filter((entry) => entry.type !== "symlink")

  async function store(candidate) {
    const files = fileEntries(candidate)

    // Enforce limits BEFORE writing anything.
    const distinctPaths = new Set([
      ...(candidate.base?.files ?? []).map((e) => e.path),
      ...(candidate.overlay ?? []).map((e) => e.path),
      ...(candidate.deletions ?? []),
    ])
    if (distinctPaths.size > maxFiles) {
      throw new Error(`candidate exceeds max files (${maxFiles}): ${distinctPaths.size} distinct paths.`)
    }
    let totalBytes = 0
    for (const file of files) {
      const bytes = Buffer.from(file.content ?? "", "base64").length
      if (bytes > maxBlobBytes) throw new Error(`blob exceeds max single blob bytes (${maxBlobBytes}): ${file.path}`)
      totalBytes += bytes
      if (totalBytes > maxTotalBytes) throw new Error(`candidate exceeds max total bytes (${maxTotalBytes}).`)
    }

    // Write blobs (wx, immutable, dedup). Verify any pre-existing blob by hash.
    await mkdir(blobsDir, { recursive: true })
    for (const file of files) {
      const blobPath = join(blobsDir, file.sha256)
      const content = Buffer.from(file.content ?? "", "base64")
      try {
        await writeFile(blobPath, content, { flag: "wx" })
      } catch (error) {
        if (error.code !== "EEXIST") throw error
        const existing = await readFile(blobPath)
        if (sha256(existing) !== file.sha256) {
          throw new Error(`BLOB_HASH_MISMATCH: existing blob ${file.sha256} does not match its content hash.`)
        }
      }
    }

    // Write the canonical entry (identity-only; blobs are referenced by hash).
    const entry = {
      candidate_id: candidate.candidate_id,
      manifest_hash: candidate.manifest_hash,
      overlay_hash: candidate.overlay_hash,
      tree_hash: candidate.tree_hash,
      manifest: candidate.manifest,
    }
    const entryPath = join(candidatesDir, `${candidate.candidate_id}.json`)
    await mkdir(candidatesDir, { recursive: true })
    try {
      await writeFile(entryPath, JSON.stringify(entry, null, 2) + "\n", { flag: "wx" })
      return { status: "STORED", candidate_id: candidate.candidate_id }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const existing = JSON.parse(await readFile(entryPath, "utf8"))
      if (existing.manifest_hash === candidate.manifest_hash && existing.tree_hash === candidate.tree_hash) {
        return { status: "REPLAYED", candidate_id: candidate.candidate_id }
      }
      throw new Error(`CANDIDATE_REGISTRY_CONFLICT: candidate_id ${candidate.candidate_id} already exists with different content.`)
    }
  }

  async function load(candidate_id) {
    const entryPath = join(candidatesDir, `${candidate_id}.json`)
    let entry
    try {
      entry = JSON.parse(await readFile(entryPath, "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }

    const hydrate = async (identityEntries) => {
      const entries = []
      for (const identity of identityEntries) {
        assertCandidatePath(identity.path)
        if (identity.type === "symlink") {
          if (typeof identity.target !== "string" || !identity.target || identity.target.startsWith("/")) {
            throw new Error(`invalid symlink target on load: ${identity.path}`)
          }
          entries.push({ path: identity.path, type: "symlink", mode: identity.mode, target: identity.target })
        } else {
          if (typeof identity.sha256 !== "string") throw new Error(`file entry missing sha256 on load: ${identity.path}`)
          const content = await readFile(join(blobsDir, identity.sha256))
          const actual = sha256(content)
          if (actual !== identity.sha256) throw new Error(`BLOB_HASH_MISMATCH on load: ${identity.sha256}`)
          entries.push({ path: identity.path, type: identity.type, mode: identity.mode, sha256: identity.sha256, content: content.toString("base64") })
        }
      }
      return entries
    }

    const baseFiles = entry.manifest.base ? await hydrate(entry.manifest.base.files ?? []) : []
    const overlay = await hydrate(entry.manifest.overlay ?? [])
    const deletions = entry.manifest.deletions ?? []
    for (const path of deletions) assertCandidatePath(path)
    assertNoDuplicatePaths(baseFiles, "base")
    assertNoDuplicatePaths(overlay, "overlay")

    // Recompute every identity layer.
    const complete = composeCandidateEntries(baseFiles, deletions, overlay)
    const recomputedManifestHash = manifestHash(entry.manifest)
    const recomputedOverlayHash = treeHash(overlay)
    const recomputedTreeHash = treeHash(complete)
    const digest = sha256(`${recomputedManifestHash}\u0000${recomputedTreeHash}`)
    const recomputedId = `cand-${digest}`

    if (recomputedId !== candidate_id) {
      throw new Error(`CANDIDATE_ID_MISMATCH on load: stored ${candidate_id}, recomputed ${recomputedId}.`)
    }
    if (recomputedManifestHash !== entry.manifest_hash || recomputedTreeHash !== entry.tree_hash || recomputedOverlayHash !== entry.overlay_hash) {
      throw new Error("CANDIDATE_HASH_MISMATCH on load: stored hashes do not recompute.")
    }

    return {
      candidate_id,
      display_id: `cand-${digest.slice(0, 16)}`,
      manifest_hash: recomputedManifestHash,
      overlay_hash: recomputedOverlayHash,
      tree_hash: recomputedTreeHash,
      manifest: entry.manifest,
      base: entry.manifest.base ? { ...entry.manifest.base, files: baseFiles } : null,
      overlay,
      deletions,
    }
  }

  return { store, load, blobsDir, candidatesDir }
}
