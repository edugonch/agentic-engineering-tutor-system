// Verification workspace: materialize a frozen candidate into a disposable
// temporary directory and verify its reconstructed tree hash.
//
// This is NOT a sandbox. It protects the repo checkout and reconstructs the
// candidate from frozen content (so a later working-tree change cannot
// contaminate the review). Network isolation and OS sandboxing are explicitly
// out of scope here.

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { captureEntries, treeHash } from "./candidate.js"

function modeFromGit(gitMode) {
  if (gitMode === "120000") return null // symlink; handled separately
  if (gitMode === "100755") return 0o755
  return 0o644
}

export async function materializeCandidate(candidate) {
  const workspace = await mkdtemp(join(tmpdir(), "harness-verify-"))
  try {
    for (const entry of candidate.entries) {
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

    // Verify the reconstruction matches the frozen candidate exactly.
    const reconstructed = await captureEntries(workspace, candidate.entries.map((entry) => entry.path))
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
