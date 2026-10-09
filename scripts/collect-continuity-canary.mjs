// Read-only evidence collector for the supported local OpenCode service.
// Never starts a service/model, prompts an agent, changes permissions or mutates
// the execution. The output contains session context: keep it with test evidence.
import { readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { validateLog } from "../src/execution/event-log.js"
import { project } from "../src/execution/state.js"

const sha = text => createHash("sha256").update(text).digest("hex")
export async function collectEvidence({ projectRoot, executionID, client }) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(executionID)) throw new Error("Invalid execution identity")
  const root = resolve(projectRoot)
  const logPath = join(root, ".harness/execution/controller", executionID, "events.ndjson")
  const raw = await readFile(logPath, "utf8")
  const events = validateLog(raw.trim().split(/\r?\n/).map(JSON.parse))
  if (!events.length) throw new Error("Execution log is empty")
  const state = project(events)
  const server = await client.server.info({ signal: AbortSignal.timeout(10000) })
  const plugins = await client.plugin.list({ location: { directory: root } }, { signal: AbortSignal.timeout(10000) })
  const identities = new Set([state.supervisor?.session_id, ...Object.values(state.dispatches).flatMap(d => [d.prepared_by_session_id, d.session_id])].filter(Boolean))
  const sessions = [], missing = []
  for (const sessionID of identities) {
    try {
      const data = await client.session.export({ sessionID, sanitize: true }, { signal: AbortSignal.timeout(30000) })
      if (data.info?.id !== sessionID) throw new Error("Session export identity mismatch")
      sessions.push({ session_id: sessionID, sha256: sha(JSON.stringify(data)), data })
    } catch (error) { missing.push({ session_id: sessionID, error: error.message }) }
  }
  const types = type => events.filter(e => e.operation_type === type)
  const afterHash = sha(await readFile(logPath, "utf8"))
  return { schema_version: 1, read_only: true, acceptance: "INDEPENDENT_REVIEW_REQUIRED", collected_at: new Date().toISOString(),
    execution_id: executionID, host_version: server.version, plugins,
    snapshot: { revision: state.revision, sha256: sha(raw), changed_during_collection: afterHash !== sha(raw), events },
    coverage: { completed_wus: Object.keys(state.completed_wus).length,
      changes_requested: types("RECORD_REVIEW").filter(e => e.body.verdict === "CHANGES_REQUIRED").length,
      waits: types("EXTERNAL_WAIT").length, resumptions: types("SUPERVISOR_SENT").length,
      verified_merges: types("MERGE_VERIFY").length,
      measured_worker_envelope_seconds: types("DISPATCH_USAGE").reduce((total, e) => total + e.body.seconds, 0),
      active_work_over_30_minutes: "NOT_PROVEN_BY_WALL_CLOCK_ALONE",
      restart_and_compaction_recovery: "REVIEW_SESSION_TRACES", user_interruption_respected: "REVIEW_SESSION_TRACES" },
    state: { completed: state.completed, blocker: state.blocker, budget: state.budget }, sessions, missing_sessions: missing }
}

async function main() {
  const [projectRoot, executionID, output] = process.argv.slice(2)
  if (!projectRoot || !executionID || !output) {
    console.log("Usage: node scripts/collect-continuity-canary.mjs PROJECT_PATH EXECUTION_ID NEW_OUTPUT.json\nRead-only; requires an already-running local OpenCode service. Writes local session evidence, never an acceptance claim.")
    process.exitCode = process.argv.includes("--help") ? 0 : 2
    return
  }
  const endpoint = await Service.discover()
  if (!endpoint) throw new Error("REAL_RUNTIME_UNAVAILABLE: no compatible running local OpenCode service; nothing was started or mutated")
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const evidence = await collectEvidence({ projectRoot, executionID, client })
  await writeFile(resolve(output), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  console.log(JSON.stringify({ output: resolve(output), acceptance: evidence.acceptance, missing_sessions: evidence.missing_sessions.length, coverage: evidence.coverage }, null, 2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
