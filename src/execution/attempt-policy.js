// Auxiliary intent guard. The event log, frozen contracts and budget are never changed.
// Keep an exact-record per execution so a new agent session cannot reset failure history.
import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const digest = data => createHash("sha256").update(JSON.stringify(data)).digest("hex")
const WATCH = new Set(["correct_verification_contract", "stage_wu_contract", "derive_and_stage_next_wu_contract"])
const safe = id => typeof id === "string" && /^[A-Za-z0-9._-]{1,200}$/.test(id) && id !== "." && id !== ".."

function classify(error) {
  const message = String(error?.message ?? "")
  if (["MISSING_WU_ARTIFACT_ID", "MISSING_REASON", "STALE_WU_CONTRACT_HASH"].includes(error?.code)) return error.code
  if (/requires a finite active_seconds or Active-time limit|invalid JSON|Unexpected token.*JSON/.test(message)) return "WU_CONTRACT_PARSE_ERROR"
  if (/Delegated correction must preserve every existing check, setup and capability/.test(message)) return "SETUP_CHANGE_REQUIRES_APPROVED_SUBSTITUTION"
  if (/Correction requires a changed valid verification contract/.test(message)) return "NO_EFFECTIVE_CHANGE"
  if (/Correction requires complete old-to-new check mapping/.test(message)) return "CHECK_MAPPING_REQUIRED"
  return null
}
function family(action) {
  return action === "correct_verification_contract" ? "verification_correction" : "wu_contract_activation"
}
function changedRequiredField(prior, input) {
  if (prior.cause === "MISSING_WU_ARTIFACT_ID") return typeof input.wu_artifact_id === "string" && input.wu_artifact_id.trim().length > 0
  if (prior.cause === "MISSING_REASON") return typeof input.reason === "string" && input.reason.trim().length > 0
  if (prior.cause === "STALE_WU_CONTRACT_HASH") return /^[a-f0-9]{64}$/.test(input.expected_contract_hash ?? "") && input.expected_contract_hash !== prior.bad_contract_hash
  return false
}
function makeError(prior) {
  const error = new Error("NO_PROGRESS_REPAIR_REQUIRED: equivalent failed strategy without new verified evidence (" + prior.cause + "). Read the exact source and controller contract; do not create another speculative WU/decision artifact.")
  error.name = "HarnessGuardError"
  error.code = "NO_PROGRESS_REPAIR_REQUIRED"
  error.cause_code = prior.cause
  return error
}
export function createCausalAttemptPolicy(projectRoot, { enabled = false } = {}) {
  const root = join(projectRoot, ".harness", "execution", "attempts")
  const pathFor = input => join(root, input.execution_id + ".json")
  async function read(input) {
    if (!safe(input?.execution_id)) return null
    try { return JSON.parse(await readFile(pathFor(input), "utf8")) }
    catch (error) { if (error.code === "ENOENT") return null; throw error }
  }
  async function save(input, entry) {
    if (!safe(input?.execution_id)) return
    await mkdir(root, { recursive: true, mode: 0o700 })
    const dest = pathFor(input), lock = dest + ".lock"
    // An in-flight parallel mutation must not silently erase intent evidence.
    const handle = await open(lock, "wx", 0o600)
    try {
      const tmp = dest + "." + randomUUID() + ".tmp"
      try { await writeFile(tmp, JSON.stringify(entry) + "\n", { mode: 0o600 }); await rename(tmp, dest) }
      finally { await rm(tmp, { force: true }) }
    } finally { await handle.close(); await rm(lock, { force: true }) }
  }
  const fingerprint = observation => digest(observation ?? { state: "unavailable" })
  return {
    async before(input, observation) {
      if (!enabled || !WATCH.has(input?.action) || !safe(input?.execution_id)) return
      const prev = await read(input)
      if (!prev || prev.family !== family(input.action) || prev.progress !== fingerprint(observation)) return
      if (changedRequiredField(prev, input)) return
      if (prev.approved_source_id && prev.approved_source_id === input.wu_artifact_id) return
      throw makeError(prev)
    },
    async failure(input, observation, error) {
      if (!enabled || !WATCH.has(input?.action) || !safe(input?.execution_id)) return
      const cause = classify(error)
      if (!cause) return
      await save(input, { schema_version: 1, family: family(input.action), cause,
        progress: fingerprint(observation), bad_contract_hash: input.expected_contract_hash ?? null })
    },
    async success(input, result) {
      if (!enabled || !safe(input?.execution_id)) return
      if (input.action === "inspect_verification_correction" && result.status === "ADMISSIBLE_READ_ONLY") {
        const prev = await read(input)
        if (prev) await save(input, { ...prev, approved_source_id: input.wu_artifact_id })
      } else if (WATCH.has(input.action) && result.commit_status === "committed") {
        await rm(pathFor(input), { force: true })
      }
    },
    read,
  }
}
