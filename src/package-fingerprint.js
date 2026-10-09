import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
export async function packageFingerprint(root) {
  const hash = createHash("sha256")
  const paths = ["index.js", "package.json"]
  async function walk(path) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${path}/${entry.name}`)
      else if (entry.isFile()) paths.push(`${path}/${entry.name}`)
    }
  }
  await walk("src")
  await walk("templates/.opencode/agents")
  for (const path of paths.sort()) hash.update(path).update("\0").update(await readFile(join(root, path))).update("\0")
  return hash.digest("hex")
}
