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
import { execFile } from "node:child_process"
import { lstat, readFile, readlink } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { stableSerialize } from "./serialize.js"
import { verificationContractHash } from "./verification-contract.js"

const exec = promisify(execFile)
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

// Capture a base snapshot from an EXACT Git commit, read from the local Git
// object database and never from the working tree.
//
// This is the recovery path for a candidate whose frozen working tree drifted
// from the bound PR head: the caller supplies the exact already-bound commit,
// so the resulting candidate Git tree equals the commit tree byte-for-byte
// (verified independently by candidateGitTree at merge/rebind time). It fails
// closed when the commit/tree cannot be resolved locally, and it never trusts
// PR text or the mutable index/working tree.
export async function captureCommitSnapshot(root, commit) {
  if (typeof commit !== "string" || !/^[0-9a-fA-F]{4,64}$/.test(commit)) {
    throw new Error(`source commit must be a Git object id: ${String(commit)}`)
  }
  // The supplied id must resolve as an actual COMMIT before any tree resolution
  // or listing. A tree object id is a valid Git object id and peels to itself
  // under `^{tree}`, so resolving only the tree would silently accept a non-commit
  // and bind the wrong source identity. Peeling to `^{commit}` both rejects
  // non-commit objects (trees, blobs) and yields the canonical commit id.
  let sourceCommit
  try {
    const { stdout } = await exec("git", ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { cwd: root, encoding: "utf8" })
    sourceCommit = stdout.trim()
  } catch {
    throw new Error(`SOURCE_COMMIT_UNRESOLVED: ${commit} is not available as a commit in the local Git object database.`)
  }
  if (!/^[0-9a-fA-F]{40,64}$/.test(sourceCommit)) throw new Error(`SOURCE_COMMIT_UNRESOLVED: ${commit} does not resolve to a commit.`)

  let tree
  try {
    const { stdout } = await exec("git", ["rev-parse", "--verify", "--quiet", `${sourceCommit}^{tree}`], { cwd: root, encoding: "utf8" })
    tree = stdout.trim()
  } catch {
    throw new Error(`SOURCE_COMMIT_UNRESOLVED: ${commit} is not available in the local Git object database.`)
  }
  if (!/^[0-9a-fA-F]{40,64}$/.test(tree)) throw new Error(`SOURCE_COMMIT_UNRESOLVED: could not resolve a tree for ${commit}.`)

  const { stdout } = await exec("git", ["ls-tree", "-r", "-z", sourceCommit], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  const files = []
  const seen = new Set()
  for (const record of stdout.split("\0")) {
    if (!record) continue
    const match = record.match(/^(\d{6}) (blob) ([0-9a-fA-F]+)\t([\s\S]+)$/)
    if (!match) throw new Error(`unexpected Git tree record: ${record}`)
    const [, mode, , oid, path] = match
    assertCandidatePath(path)
    if (seen.has(path)) throw new Error(`duplicate path in Git tree: ${path}`)
    seen.add(path)
    const { stdout: raw } = await exec("git", ["cat-file", "blob", oid], { cwd: root, encoding: "buffer", maxBuffer: 10 * 1024 * 1024 })
    const bytes = Buffer.from(raw)
    if (mode === "120000") {
      files.push({ path, type: "symlink", mode, target: bytes.toString("utf8") })
    } else if (mode === "100644" || mode === "100755") {
      files.push({ path, type: "file", mode, sha256: sha256(bytes), content: bytes.toString("base64") })
    } else {
      throw new Error(`unsupported Git mode ${mode} for ${path}`)
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { kind: "commit", commit: sourceCommit, tree, files }
}

// Reproducible freeze from an exact Git commit: base = the commit tree, no
// working-tree overlay or deletions. Recording kind/commit/tree on the base
// binds the source (identity) while the verification contract is preserved.
export async function freezeCandidateFromCommit(root, { commit, verification_contract = null } = {}) {
  const base = await captureCommitSnapshot(root, commit)
  return freezeCandidate(root, { base, paths: [], deletions: [], verification_contract })
}

// Reproducible freeze: validate → capture → verify working paths unchanged → publish.
export async function freezeCandidate(root, { base = null, paths = [], deletions = [], verification_contract = null } = {}) {
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
    base: base
      ? {
          kind: base.kind ?? "snapshot",
          commit: base.commit ?? null,
          ...(base.tree ? { tree: base.tree } : {}),
          files: baseFiles.map(identityOnly),
        }
      : null,
    deletions: sortedDeletions,
    overlay: overlay.map(identityOnly),
    verification_contract: verification_contract
      ? {
          contract_hash: verificationContractHash(verification_contract),
          source_wu_id: verification_contract.source_wu_id ?? null,
          source_wu_revision: verification_contract.source_wu_revision ?? null,
          source_wu_hash: verification_contract.source_wu_hash ?? null,
        }
      : null,
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
    verification_contract,
  }
}
