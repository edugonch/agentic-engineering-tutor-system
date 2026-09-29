import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

const GLOBAL_AGENT_IDS = Object.freeze([
  "harness-builder",
  "harness-researcher",
  "harness-reviewer",
  "harness-designer",
])
const MANIFEST_NAME = ".agentic-harness-managed-agents.json"

const sha256 = (value) => createHash("sha256").update(value).digest("hex")

export function resolveOpenCodeConfigDir(env = process.env, home = homedir()) {
  if (env.OPENCODE_CONFIG_DIR) {
    if (!isAbsolute(env.OPENCODE_CONFIG_DIR)) throw new Error("OPENCODE_CONFIG_DIR must be an absolute path.")
    return resolve(env.OPENCODE_CONFIG_DIR)
  }
  if (env.XDG_CONFIG_HOME) {
    if (!isAbsolute(env.XDG_CONFIG_HOME)) throw new Error("XDG_CONFIG_HOME must be an absolute path.")
    return join(resolve(env.XDG_CONFIG_HOME), "opencode")
  }
  return join(home, ".config", "opencode")
}

async function readRegularFile(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to use a non-regular Harness agent file: ${path}`)
    return await readFile(path, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing to write through a non-directory or symlink: ${path}`)
}

async function writeAtomic(path, content) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, { flag: "wx", mode: 0o600 })
  try {
    await rename(temp, path)
  } catch (error) {
    try { await unlink(temp) } catch {}
    throw error
  }
}

async function readManifest(path) {
  const content = await readRegularFile(path)
  if (content === null) return { version: 1, files: {} }
  let manifest
  try { manifest = JSON.parse(content) } catch { throw new Error("The Harness global agent manifest is malformed; preserved it and stopped provisioning.") }
  if (manifest?.version !== 1 || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("The Harness global agent manifest has an unsupported shape; preserved it and stopped provisioning.")
  }
  return manifest
}

async function createIfAbsent(path, content) {
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 })
    return true
  } catch (error) {
    if (error.code === "EEXIST") return false
    throw error
  }
}

/**
 * Make Harness specialist profiles available globally when the plugin loads.
 * New files are created; unchanged plugin-managed files are upgraded; files
 * with user edits or no ownership record are preserved.
 */
export async function provisionGlobalHarnessAgents({ packageRoot, configDir }) {
  if (!packageRoot || !isAbsolute(packageRoot)) throw new Error("packageRoot must be an absolute path.")
  if (!configDir || !isAbsolute(configDir)) throw new Error("configDir must be an absolute path.")

  await ensureDirectory(configDir)
  const canonicalConfig = await realpath(configDir)
  const agentDir = join(canonicalConfig, "agents")
  await ensureDirectory(agentDir)
  const manifestPath = join(agentDir, MANIFEST_NAME)
  const manifest = await readManifest(manifestPath)
  const nextFiles = { ...manifest.files }
  const result = { status: "ready", config_dir: canonicalConfig, created: [], updated: [], unchanged: [], preserved: [], errors: [] }

  for (const id of GLOBAL_AGENT_IDS) {
    const source = join(packageRoot, "templates", ".opencode", "agents", `${id}.md`)
    const template = await readFile(source, "utf8")
    const target = join(agentDir, `${id}.md`)
    const current = await readRegularFile(target)
    const currentHash = current === null ? null : sha256(current)
    const templateHash = sha256(template)
    const previousHash = manifest.files[id]?.sha256

    if (currentHash === templateHash) {
      result.unchanged.push(id)
      nextFiles[id] = { sha256: templateHash }
      continue
    }
    if (current === null) {
      if (await createIfAbsent(target, template)) {
        result.created.push(id)
        nextFiles[id] = { sha256: templateHash }
      } else {
        const raced = await readRegularFile(target)
        if (raced === template) {
          result.unchanged.push(id)
          nextFiles[id] = { sha256: templateHash }
        } else {
          result.preserved.push({ id, reason: "A profile appeared during installation and was left untouched." })
          delete nextFiles[id]
        }
      }
      continue
    }
    if (previousHash && currentHash === previousHash) {
      await writeAtomic(target, template)
      result.updated.push(id)
      nextFiles[id] = { sha256: templateHash }
      continue
    }

    result.preserved.push({ id, reason: "An existing profile is user-owned or has local edits; it was not overwritten." })
    delete nextFiles[id]
  }

  const nextManifest = `${JSON.stringify({ version: 1, files: nextFiles }, null, 2)}\n`
  const oldManifest = await readRegularFile(manifestPath)
  if (oldManifest !== nextManifest) {
    if (oldManifest === null) {
      if (!(await createIfAbsent(manifestPath, nextManifest))) {
        throw new Error("The Harness global agent manifest appeared during installation; preserved it and stopped updating the manifest.")
      }
    } else {
      await writeAtomic(manifestPath, nextManifest)
    }
  }

  result.changed = result.created.length > 0 || result.updated.length > 0
  result.status = result.preserved.length > 0 ? "ready_with_preserved_profiles" : "ready"
  return result
}
