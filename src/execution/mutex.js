// Short-lived process mutex used to serialize lease acquisition and event-log
// commits. It is a lock, not the fencing lease: the lease carries ownership and
// fencing, this mutex only prevents two writers from racing the same files.

import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

const MUTEX_TIMEOUT_MS = 15000

export async function withMutex(lockPath, operation) {
  await mkdir(dirname(lockPath), { recursive: true })
  const token = randomUUID()
  const deadline = Date.now() + MUTEX_TIMEOUT_MS

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() })) }
      finally { await handle.close() }
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      let stale = false
      try {
        const info = await lstat(lockPath)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Refusing to use an unsafe execution mutex.")
        let owner
        try { owner = JSON.parse(await readFile(lockPath, "utf8")) } catch {}
        const age = Date.now() - info.mtimeMs
        if (!Number.isInteger(owner?.pid)) stale = age > 5000
        else {
          try { process.kill(owner.pid, 0) }
          catch (probeError) { if (probeError.code === "ESRCH") stale = true }
        }
        if (stale) await unlink(lockPath)
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError
      }
      if (Date.now() >= deadline) throw new Error("Execution state is busy in another session; retry after that write completes.")
      await new Promise((resolveDelay) => setTimeout(resolveDelay, stale ? 0 : 30 + Math.floor(Math.random() * 40)))
    }
  }

  try { return await operation() }
  finally {
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8"))
      if (owner.token === token) await unlink(lockPath)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
}
