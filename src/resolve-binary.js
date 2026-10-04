import { statSync } from "node:fs"
import { isAbsolute, join } from "node:path"

export function resolveBinary(program, env = process.env) {
  if (!program) return null
  if (isAbsolute(program)) {
    try {
      const info = statSync(program)
      if (info.isFile() && (info.mode & 0o111) !== 0) return program
    } catch {}
    return null
  }
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue
    const candidate = join(dir, program)
    try {
      const info = statSync(candidate)
      if (info.isFile() && (info.mode & 0o111) !== 0) return candidate
    } catch {}
  }
  return null
}
