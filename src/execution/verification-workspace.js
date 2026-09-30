// Verification workspace: materialize a COMPLETE candidate tree into a
// disposable temporary directory and verify its reconstructed tree hash.
//
// Materialization order: base (unchanged files) → apply deletions → overlay
// (changed files) → recompute the complete tree via composeCandidateEntries and
// compare to candidate.tree_hash. All paths are re-validated here too, because
// the candidate may later arrive from durable storage (a distinct trust boundary).
//
// This is NOT a sandbox. It protects the repo checkout and reconstructs the
// candidate from frozen content. Network isolation and OS sandboxing are
// explicitly out of scope.

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { assertCandidatePath, captureEntries, composeCandidateEntries, treeHash } from "./candidate.js"

function modeFromGit(gitMode) {
  if (gitMode === "120000") return null // symlink; handled separately
  if (gitMode === "100755") return 0o755
  return 0o644
}

async function writeEntry(workspace, entry) {
  assertCandidatePath(entry.path)
  const dest = join(workspace, entry.path)
  await mkdir(dirname(dest), { recursive: true })
  if (entry.type === "symlink") {
    await symlink(entry.target, dest)
  } else if (entry.content != null) {
    await writeFile(dest, Buffer.from(entry.content, "base64"), { mode: modeFromGit(entry.mode) })
  } else {
    throw new Error(`entry ${entry.path} has no frozen content to materialize.`)
  }
}

export async function materializeCandidate(candidate) {
  const workspace = await mkdtemp(join(tmpdir(), "harness-verify-"))
  try {
    const baseFiles = candidate.base?.files ?? []
    const overlay = candidate.overlay ?? []
    const deletions = candidate.deletions ?? []

    for (const file of baseFiles) assertCandidatePath(file.path)
    for (const entry of overlay) assertCandidatePath(entry.path)
    for (const path of deletions) assertCandidatePath(path)

    // 1. materialize base (unchanged files)
    for (const file of baseFiles) await writeEntry(workspace, file)
    // 2. apply deletions
    for (const path of deletions) await rm(join(workspace, path), { recursive: false, force: true })
    // 3. overlay frozen entries (modified/new files; may re-create a deleted path)
    for (const entry of overlay) await writeEntry(workspace, entry)

    // 4. recompute the complete tree (base → delete → overlay) and verify
    const complete = composeCandidateEntries(baseFiles, deletions, overlay)
    const reconstructed = await captureEntries(workspace, complete.map((entry) => entry.path))
    const reconstructedHash = treeHash(reconstructed)
    if (reconstructedHash !== candidate.tree_hash) {
      throw new Error(`Reconstructed workspace tree hash differs: ${reconstructedHash} vs ${candidate.tree_hash}`)
    }

    return { workspace, verified: true, tree_hash: reconstructedHash }
  } catch (error) {
    await rm(workspace, { recursive: true, force: true })
    throw error
  }
}

export async function disposeWorkspace(workspace) {
  await rm(workspace, { recursive: true, force: true })
}
