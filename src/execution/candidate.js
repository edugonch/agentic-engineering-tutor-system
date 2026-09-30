// Candidate identity + reproducible freeze.
//
// A candidate is described by two independent hashes:
//
//   manifest_hash — identity of the candidate description (base, entries,
//                   deletions); volatile metadata (timestamp) is excluded.
//   tree_hash     — identity of the material tree reconstructed from entries.
//
// freezeCandidate captures the actual working tree (files by content hash,
// symlinks as symlinks without following), verifies nothing changed during the
// capture (freeze-race detection), and fails closed on a symlink that escapes
// the repository root.

import { createHash } from "node:crypto"
import { lstat, readFile, readlink } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { stableSerialize } from "./serialize.js"

const sha256 = (value) => createHash("sha256").update(value).digest("hex")

function inside(root, path) {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function gitMode(info) {
  if (info.isSymbolicLink()) return "120000"
  return (info.mode & 0o111) !== 0 ? "100755" : "100644"
}

export function manifestHash(manifest) {
  const { captured_at: _timestamp, ...identity } = manifest ?? {}
  return sha256(stableSerialize(identity))
}

export function treeHash(entries) {
  const lines = entries
    .map((entry) => {
      const path = String(entry.path ?? "")
      const type = String(entry.type ?? "file")
      const digest = String(entry.sha256 ?? "")
      const target = String(entry.target ?? "")
      const mode = String(entry.mode ?? "")
      return `${path}\u0000${type}\u0000${digest}\u0000${target}\u0000${mode}`
    })
    .sort()
    .join("\n")
  return sha256(lines)
}

// Capture one path as a content entry. Returns null for non-content entries
// (directories, sockets, devices), which are not part of the candidate tree.
// Fails closed on a symlink whose target escapes the repository root.
export async function captureEntry(root, relPath) {
  if (isAbsolute(relPath)) throw new Error("entry paths must be relative to the project root.")
  const full = resolve(root, relPath)
  if (!inside(root, full)) throw new Error(`entry path escapes the project root: ${relPath}`)

  const info = await lstat(full) // lstat: do not follow symlinks
  if (info.isSymbolicLink()) {
    const target = await readlink(full)
    const resolvedTarget = resolve(dirname(full), target)
    if (!inside(root, resolvedTarget)) {
      throw new Error(`symlink escapes the repository and the candidate fails closed: ${relPath} -> ${target}`)
    }
    return { path: relPath, type: "symlink", mode: gitMode(info), target }
  }
  if (!info.isFile()) return null
  const content = await readFile(full)
  return { path: relPath, type: "file", mode: gitMode(info), sha256: sha256(content) }
}

export async function captureEntries(root, paths) {
  const entries = []
  for (const relPath of paths) {
    const entry = await captureEntry(root, relPath)
    if (entry) entries.push(entry)
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return entries
}

// Reproducible freeze: scan → capture → verify working paths unchanged → publish.
export async function freezeCandidate(root, { paths = [], deletions = [], base = null } = {}) {
  const entries = await captureEntries(root, paths)

  // Freeze-race detection: a second, fresh capture must hash identically.
  const recheck = await captureEntries(root, paths)
  if (treeHash(entries) !== treeHash(recheck)) {
    throw new Error("CANDIDATE_CHANGED_DURING_FREEZE: a path changed while the candidate was being captured.")
  }

  const manifest = {
    base,
    deletions: [...new Set(deletions)].sort(),
    entries,
    captured_at: new Date().toISOString(), // metadata only, not identity
  }
  const manifest_hash = manifestHash(manifest)
  const tree_hash = treeHash(entries)
  const candidate_id = `cand-${tree_hash.slice(0, 16)}`

  return { candidate_id, manifest_hash, tree_hash, manifest, entries }
}
