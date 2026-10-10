// Trusted source transport, separate from candidate execution. No shell text,
// candidate programs, caller-supplied environment, or external write operation.
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join, relative, isAbsolute, resolve, dirname } from "node:path"
import { resolveBinary } from "./resolve-binary.js"
import { readProjectInstructions } from "./project-instructions.js"
import { stableHash } from "./execution/serialize.js"
const exec = promisify(execFile)
const CLI = "@withone/cli@2.6.0"
const string = (v, name) => { if (typeof v !== "string" || !v || v.startsWith("-") || /[\r\n\0]/.test(v)) throw new Error(`Invalid ${name}`); return v }
export function oneReadArgs(input) {
  const op = input.operation
  if (op === "list") return ["list"]
  if (op === "find") return ["actions", "find", string(input.platform, "platform"), string(input.intent, "intent")]
  if (op === "knowledge") return ["actions", "load", string(input.action_id, "action_id"), "--full", "--no-cache"]
  if (op !== "read") throw new Error("Supported One operations: list, find, knowledge, read")
  const vars = input.path_variables
  if (!vars || typeof vars !== "object" || Array.isArray(vars) || !Object.values(vars).includes(string(input.source_id, "source_id"))) throw new Error("Exact source_id must be present in path_variables")
  if (input.query_params !== undefined && (!input.query_params || typeof input.query_params !== "object" || Array.isArray(input.query_params))) throw new Error("query_params must be an object")
  return ["actions", "execute", string(input.platform, "platform"), string(input.action_id, "action_id"), string(input.connection_key, "connection_key"), "--path-vars", JSON.stringify(vars), "--query-params", JSON.stringify(input.query_params ?? {}), "--no-cache"]
}
export function assertReadPreview(preview, sourceId) {
  if (preview?.dryRun !== true || preview?.request?.method?.toUpperCase() !== "GET") throw new Error("Source action must resolve to a GET request")
  const url = new URL(preview.request.url)
  if (url.protocol !== "https:" || !url.pathname.split("/").map(decodeURIComponent).includes(sourceId)) throw new Error("Resolved request does not address the exact source ID over HTTPS")
}
export function ghReadArgs(input) {
  const endpoint = string(input.endpoint, "endpoint")
  // REST repository facts only; no GraphQL mutations, arbitrary host, download,
  // credential output, aliases, local extensions, or caller-controlled method.
  if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pulls|commits|contents|actions\/runs|check-runs)(?:\/[A-Za-z0-9_.~%-]+)*(?:\?[^\r\n#]*)?$/.test(endpoint) || endpoint.includes("..") || /%2f|%2e/i.test(endpoint)) throw new Error("Unsupported GitHub read endpoint")
  return ["api", "--method", "GET", endpoint]
}
export async function runSourceProcess(program, args, { cwd, env, signal }) {
  try {
    const result = await exec(program, args, { cwd, env, signal, timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", shell: false })
    return JSON.parse(result.stdout)
  } catch (error) {
    // CLI stdout/stderr can contain credentials (notably dry-run headers).
    // Never reflect either on an error or persist a credential-bearing preview.
    throw new Error(`SOURCE_TRANSPORT_FAILED: ${error.code ?? error.name}; no complete source evidence returned`)
  }
}
// One 2.6.0 config precedence, from withoneai/cli src/lib/config.ts:
// closest home-backed project config, then global. Resolve without invoking the
// CLI in the repository: even `config path` can auto-refresh project skills.
export async function loadOneConfig(root) {
  const home = process.env.HOME ?? homedir()
  const paths = []
  let dir = resolve(root)
  while (true) {
    paths.push(join(home, ".one", "projects", dir.replace(/[\\/<>:\"|?*]/g, "-"), "config.json"))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  paths.push(join(home, ".one", "config.json"))
  for (const path of paths) {
    try {
      const base = await realpath(join(home, ".one"))
      const actual = await realpath(path)
      const rel = relative(base, actual)
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("One credential path escapes its directory")
      return JSON.parse(await readFile(actual, "utf8"))
    } catch (error) { if (error.code !== "ENOENT") throw error }
  }
  return {}
}
export async function readExternalSource(root, input, { run = runSourceProcess, resolveProgram = resolveBinary, signal } = {}) {
  const authority = await readProjectInstructions(root, ["AGENTS.md", ...(input.authority_paths ?? [])])
  const text = authority.documents.map(d => d.content).join("\n")
  const one = input.provider === "one"
  if (!one && input.provider !== "github") throw new Error("Unsupported source provider")
  if (one && !/WithOne|@withone\/cli|\bOne (?:CLI|MCP|Google)/i.test(text)) throw new Error("Project authority must name the One access route")
  if (one && input.operation === "read" && (!input.source_id || !text.includes(input.source_id))) throw new Error("Exact source_id must be named in the supplied project authority")
  const args = one ? oneReadArgs(input) : ghReadArgs(input)
  if (!one && !text.includes(input.endpoint.split("/").slice(0,3).join("/")) && !text.includes(input.endpoint.split("/").slice(1,3).join("/"))) throw new Error("GitHub repository must be named in the supplied project authority")
  const baseEnv = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "LANG", "TMPDIR", "SYSTEMROOT"].filter(k => process.env[k]).map(k => [k, process.env[k]]))
  if (!one) {
    const program = resolveProgram("gh")
    if (!program) throw new Error("SOURCE_CLI_MISSING: gh; orchestrator may bootstrap under project policy")
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"]) if (process.env[k]) baseEnv[k] = process.env[k]
    const data = await run(program, args, { cwd: root, env: { ...baseEnv, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" }, signal })
    return { provider: "github", observed_at: new Date().toISOString(), authority_fingerprint: authority.fingerprint, content_hash: stableHash(data), data, completeness: "Verify pagination and source revision before acceptance" }
  }
  // Always use the audited, pinned CLI. npm cache is reused; bootstrap is only
  // reached after project authority explicitly names the One route.
  const program = resolveProgram("npx")
  if (!program) throw new Error("SOURCE_CLI_MISSING: npx; orchestrator may bootstrap Node under project policy")
  const prefix = ["--yes", "--package", CLI, "one", "--agent"]
  const env = { ...baseEnv, ONE_NO_AUTO_UPDATE: "1", ONE_NO_TELEMETRY: "1", ONE_AGENT: "1" }
  const original = await loadOneConfig(root)
  let rc = {}
  try {
    rc = Object.fromEntries((await readFile(join(root, ".onerc"), "utf8")).split("\n").filter(line => line.trim() && !line.trim().startsWith("#") && line.includes("=")).map(line => { const i = line.indexOf("="); return [line.slice(0, i).trim(), line.slice(i + 1).trim()] }))
  } catch (error) { if (error.code !== "ENOENT") throw error }
  original.accessControl = { ...original.accessControl }
  for (const [key, field] of [["ONE_CONNECTION_KEYS", "connectionKeys"], ["ONE_ACTION_IDS", "actionIds"]]) {
    if (rc[key]) original.accessControl[field] = rc[key].split(",").map(v => v.trim()).filter(Boolean)
  }
  if (rc.ONE_KNOWLEDGE_AGENT) original.accessControl.knowledgeAgent = rc.ONE_KNOWLEDGE_AGENT === "true"
  if (process.env.ONE_SECRET || rc.ONE_SECRET) original.apiKey = process.env.ONE_SECRET || rc.ONE_SECRET

  if (!original.apiKey) throw new Error("SOURCE_AUTH_REQUIRED: run the project-authorized One initialization in the orchestrator")
  const temp = await mkdtemp(join(tmpdir(), "harness-source-"))
  try {
    await mkdir(join(temp, ".one"), { mode: 0o700 })
    // Preserve original connection/action/knowledge restrictions and narrow
    // methods. Credentials never enter candidate workspaces or tool responses.
    await writeFile(join(temp, ".one", "config.json"), JSON.stringify({ apiKey: original.apiKey, ...(original.apiBase ? { apiBase: original.apiBase } : {}), accessControl: { ...original.accessControl, permissions: "read" } }), { mode: 0o600 })
    await writeFile(join(temp, ".onerc"), "ONE_PERMISSIONS=read\n", { mode: 0o600 })
    const isolated = { cwd: temp, env: { ...env, HOME: temp, USERPROFILE: temp }, signal }
    if (input.operation === "read") {
      // Load current schema before executing; never accept caller-authored
      // method assertions. Do not surface the dry-run request headers.
      await run(program, [...prefix, "actions", "load", input.action_id, "--full", "--no-cache"], isolated)
      const preview = await run(program, [...prefix, ...args, "--dry-run"], isolated)
      assertReadPreview(preview, input.source_id)
    }
    const raw = await run(program, [...prefix, ...args], isolated)
    const data = JSON.parse(JSON.stringify(raw).split(original.apiKey).join("[REDACTED]"))
    return { provider: "one", observed_at: new Date().toISOString(), source_id: input.source_id ?? null, authority_fingerprint: authority.fingerprint, content_hash: stableHash(data), data, completeness: "Verify pagination and source revision before acceptance; each response is one observation, never automatic PASS" }
  } finally { await rm(temp, { recursive: true, force: true }) }
}
