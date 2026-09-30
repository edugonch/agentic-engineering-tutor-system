// Candidate identity + reproducible freeze.
//
// A candidate is a COMPLETE, reproducible tree:
//
//   base (unchanged files)  − deletions  + overlay (changed files)
//
// The composition is a single canonical rule (base → delete → overlay) shared by
// freeze, materialization, and registry validation, so no layer implements a
// subtly different merge:
//
//   composeCandidateEntries(baseFiles, deletions, overlay)
//
// Identity layers:
//
//   manifest_hash — description: base identity + deletions + overlay identity
//   overlay_hash  — the changed material only
//   tree_hash     — the complete resulting tree (composed)
//   candidate_id  — full identity: hash(manifest_hash, tree_hash), full 64 hex
//   display_id    — short ergonomic prefix (never an authoritative key)

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

const identityOnly = ({ content: _content, ...identity }) => identity

// Validate a candidate path. Rejects absolute paths, traversal, empty/`.`/`..`
// segments, backslashes, and NUL bytes. Applied to base, overlay, and deletion
// paths alike — at freeze time, at materialization, and again at registry load.
export function assertCandidatePath(path) {
  if (typeof path !== "string" || path.length === 0) throw new Error("candidate path must be a non-empty string.")
  if (path.includes("\0")) throw new Error(`candidate path must not contain a NUL byte: ${path}`)
  if (isAbsolute(path)) throw new Error(`candidate path must be relative: ${path}`)
  if (path.includes("\\")) throw new Error(`candidate path must use forward slashes: ${path}`)
  const segments = path.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`candidate path must not contain empty, '.', or '..' segments: ${path}`)
  }
  return path
}

function assertNoDuplicatePaths(paths, label) {
  const seen = new Set()
  for (const path of paths) {
    if (seen.has(path)) throw new Error(`duplicate ${label} path: ${path}`)
    seen.add(path)
  }
}

// Canonical composition: base → delete → overlay (replace/add). Unique by path.
export function composeCandidateEntries(baseFiles, deletions, overlay) {
  const map = new Map()
  for (const file of baseFiles) map.set(file.path, file)
  for (const path of deletions) map.delete(path)
  for (const entry of overlay) map.set(entry.path, entry)
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export function manifestHash(manifest) {
  const { captured_at: _timestamp, ...identity } = manifest ?? {}
  return sha256(stableSerialize(identity))
}

// Hash a list of content entries (files and symlinks) deterministically.
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

// Capture one path as a content entry. Returns null for non-content entries.
// Fails closed on a symlink whose target escapes the repository root.
export async function captureEntry(root, relPath) {
  assertCandidatePath(relPath)
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
  return { path: relPath, type: "file", mode: gitMode(info), sha256: sha256(content), content: content.toString("base64") }
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

// Capture a base snapshot (unchanged files, with content) for a non-Git base.
export async function captureBaseSnapshot(root, paths) {
  const files = await captureEntries(root, paths)
  return { kind: "snapshot", commit: null, files }
}

// Reproducible freeze: validate → capture → verify working paths unchanged → publish.
export async function freezeCandidate(root, { base = null, paths = [], deletions = [] } = {}) {
  for (const path of paths) assertCandidatePath(path)
  for (const path of deletions) assertCandidatePath(path)

  const baseFiles = base?.files ?? []
  for (const file of baseFiles) assertCandidatePath(file.path)

  const sortedDeletions = [...new Set(deletions)].sort()
  assertNoDuplicatePaths(paths, "overlay")
  assertNoDuplicatePaths(baseFiles.map((file) => file.path), "base")
  assertNoDuplicatePaths(sortedDeletions, "deletion")

  const overlay = await captureEntries(root, paths)

  // Freeze-race detection: a second, fresh capture must hash identically.
  const recheck = await captureEntries(root, paths)
  if (treeHash(overlay) !== treeHash(recheck)) {
    throw new Error("CANDIDATE_CHANGED_DURING_FREEZE: a path changed while the candidate was being captured.")
  }

  const completeEntries = composeCandidateEntries(baseFiles, sortedDeletions, overlay)

  const manifest = {
    base: base ? { kind: base.kind ?? "snapshot", commit: base.commit ?? null, files: baseFiles.map(identityOnly) } : null,
    deletions: sortedDeletions,
    overlay: overlay.map(identityOnly),
    captured_at: new Date().toISOString(), // metadata only, not identity
  }

  const manifest_hash = manifestHash(manifest)
  const overlay_hash = treeHash(overlay)
  const tree_hash = treeHash(completeEntries)
  const digest = sha256(`${manifest_hash}\u0000${tree_hash}`)
  const candidate_id = `cand-${digest}`
  const display_id = `cand-${digest.slice(0, 16)}`

  return {
    candidate_id,
    display_id,
    manifest_hash,
    overlay_hash,
    tree_hash,
    manifest,
    base: base ? { ...base, files: baseFiles } : null,
    overlay,
    deletions: sortedDeletions,
  }
}
