import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { assertCandidatePath } from "./candidate.js"
const exec = promisify(execFile)
export async function trackedCandidatePaths(root, additions = [], deletions = []) {
  const { stdout } = await exec("git", ["ls-files", "--cached", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  const paths = new Set([...stdout.split("\0").filter(Boolean), ...additions])
  const removed = new Set(deletions)
  const result = []
  for (const path of paths) {
    assertCandidatePath(path)
    if (removed.has(path)) continue
    try { await lstat(join(root, path)); result.push(path) }
    catch (error) { if (error.code !== "ENOENT") throw error }
  }
  return result.sort()
}
