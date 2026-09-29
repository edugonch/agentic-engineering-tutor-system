// Candidate identity. A candidate is described by two independent hashes:
//
//   manifest_hash — identifies the candidate's description (base HEAD, paths,
//                   deletions, authorized untracked files, modes, symlinks).
//   tree_hash     — identifies the material tree reconstructed from the manifest.
//
// review(candidate_id=A) therefore binds to exactly (manifest_hash X, tree_hash Y).
// A one-line repair produces candidate B with different hashes, and PASS(A)
// can never accredit B.

import { stableSerialize } from "./serialize.js"
import { createHash } from "node:crypto"

const sha256 = (text) => createHash("sha256").update(text).digest("hex")

export function manifestHash(manifest) {
  return sha256(stableSerialize(manifest))
}

export function treeHash(entries) {
  const lines = entries
    .map((entry) => {
      const path = String(entry.path ?? "")
      const digest = String(entry.sha256 ?? "")
      const mode = String(entry.mode ?? "")
      return `${path}\u0000${digest}\u0000${mode}`
    })
    .sort()
    .join("\n")
  return sha256(lines)
}
