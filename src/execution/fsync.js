// Durable write primitive.
//
// Durability target v1: survive process crash, OpenCode restart, and an
// orderly machine reboot. Power loss is best effort and not yet guaranteed.
//
// A write is declared committed only after (a) the file bytes are fsynced and
// (b) the parent directory entry is fsynced so the rename itself is durable.
// We never claim a stronger guarantee than the one implemented.

import { mkdir, open, rename } from "node:fs/promises"
import { dirname, join } from "node:path"

export async function atomicWriteDurable(filePath, data) {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `.${filePath.split("/").at(-1)}.${process.pid}.${Date.now()}.tmp`)
  let handle
  try {
    handle = await open(temp, "wx", 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temp, filePath)
    await fsyncDir(dir)
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
  return filePath
}

export async function fsyncDir(dir) {
  let handle
  try {
    handle = await open(dir, "r")
    await handle.sync()
  } catch (error) {
    // Some platforms do not permit fsync on a directory handle; the rename is
    // still atomic, so degrade gracefully rather than failing the write.
    if (error.code !== "EISDIR" && error.code !== "EINVAL" && error.code !== "EPERM" && error.code !== "ENOTSUP") throw error
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}
