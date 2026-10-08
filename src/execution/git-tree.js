import { createHash } from "node:crypto"
import { assertCandidatePath, composeCandidateEntries } from "./candidate.js"

function objectHash(type, bytes) {
  return createHash("sha1").update(Buffer.from(`${type} ${bytes.length}\0`)).update(bytes).digest()
}

// Git's tree identity includes every path, file mode, symlink and byte. Unlike
// a caller-supplied head SHA this can be compared with the remote commit tree.
export function candidateGitTree(candidate) {
  const root = new Map()
  for (const entry of composeCandidateEntries(candidate.base?.files ?? [], candidate.deletions ?? [], candidate.overlay ?? [])) {
    const parts = assertCandidatePath(entry.path).split("/")
    let dir = root
    for (const name of parts.slice(0, -1)) {
      if (!dir.has(name)) dir.set(name, new Map())
      dir = dir.get(name)
      if (!(dir instanceof Map)) throw new Error("Candidate file/directory collision.")
    }
    const name = parts.at(-1)
    if (dir.has(name)) throw new Error("Candidate file/directory collision.")
    const mode = entry.type === "symlink" ? "120000" : entry.mode ?? "100644"
    if (!["100644", "100755", "120000"].includes(mode)) throw new Error(`Unsupported Git mode ${mode}.`)
    const bytes = entry.type === "symlink" ? Buffer.from(entry.target) : Buffer.from(entry.content, "base64")
    dir.set(name, { mode, hash: objectHash("blob", bytes) })
  }
  function tree(dir) {
    const entries = [...dir].map(([name, value]) => value instanceof Map
      ? { name, sort: `${name}/`, mode: "40000", hash: tree(value) }
      : { name, sort: name, ...value })
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)))
    return objectHash("tree", Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), e.hash]))))
  }
  return tree(root).toString("hex")
}
