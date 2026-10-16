// The approved Epic authorizes the next *frozen* WU to execute, not an owner
// APPROVED label on every technical normalization. Keep these authorities distinct.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { compileWuContract } from "./wu-contract.js"
import { stableHash } from "./serialize.js"
import { epicExecutionRemaining, usesPlanningEstimates } from "./time-policy.js"

export const isTechnicalWuContractBlocker = blocker =>
  blocker?.class === "BLOCKED_AUTHORITY" &&
  (!blocker.authority_question || blocker.authority_question.domain === "governance") &&
  /(?:no executable approved contract|no executable contract|needs a selected approved contract|finite active_seconds|execution_contract|WU_CONTRACT_REQUIRED|normaliz(?:ation|e).*contract)/i.test(String(blocker.reason ?? ""))

const SCRIPT_ORDER = ["format:check", "lint", "typecheck", "arch", "governance:verify", "governance:test", "test"]
const FORBIDDEN_SCRIPTS = /(?:^|:)(?:deploy|publish|release|production|migrate|seed|reset|delete|write)(?:$|:)/i

// Deterministic conservative baseline, sourced from actual repository scripts.
// Never trust arbitrary shell programs or invent a missing test command.
export async function deriveVerificationContract(projectRoot) {
  let pkg
  try { pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) }
  catch { throw new Error("JIT_VERIFICATION_REQUIRED: readable repository package.json is required") }
  const scripts = pkg?.scripts ?? {}
  const present = SCRIPT_ORDER.filter(name => typeof scripts[name] === "string" && scripts[name].trim() && !FORBIDDEN_SCRIPTS.test(name))
  if (!present.length) throw new Error("JIT_VERIFICATION_REQUIRED: no supported verification scripts are declared")
  return {
    setup: [{ id: "jit-install", program: "npm", args: ["ci"], timeout_ms: 300000 }],
    commands: present.map(name => ({ id: `jit-${name.replace(/[^a-z0-9]/gi, "-")}`, program: "npm", args: ["run", name], timeout_ms: 300000 })),
    environment: { network_policy: "UNRESTRICTED" },
    capabilities: [],
  }
}

// The estimate is derived from the *remaining Epic allocation* and remaining
// frozen WU count. Under WU_PLANNING_ESTIMATES this is not an individual hard cap.
export async function compileMandateDerivedWu(root, state, wuId, definition) {
  if (!usesPlanningEstimates(state)) throw new Error("JIT_TIME_POLICY_REQUIRED: approved WU_PLANNING_ESTIMATES policy is required")
  if (!/^status: "(?:DRAFT|PROPOSED)"\s*$/m.test(definition.content)) throw new Error("JIT_SOURCE_REQUIRED: only a planning DRAFT or PROPOSED WU can be normalized")
  if (/^execution_contract: /m.test(definition.content)) throw new Error("JIT_SOURCE_ALREADY_EXECUTABLE: select the existing executable source instead")
  // A planning identity alone is not permission to invent acceptance or scope.
  // Require visible existing acceptance and scope language in the frozen source.
  if (!/(?:salida comprobable|acceptance criteria|original acceptance|accept:)/i.test(definition.content) ||
      !/(?:expected write scope|bounded scope|scope:|fuera de alcance)/i.test(definition.content)) {
    throw new Error("JIT_SOURCE_INCOMPLETE: acceptance and expected write scope must exist in the original WU")
  }
  const sequence = state.mandate?.wu_sequence ?? []
  const index = state.activated_wu_ids.length
  if (sequence[index] !== wuId || state.wu && !state.wu.completed) throw new Error("JIT_WU_ORDER: next frozen WU with completed predecessor required")
  const remaining = epicExecutionRemaining(state)
  const remainingWus = sequence.length - index
  if (!Number.isFinite(remaining) || remaining <= 0 || remainingWus < 1) throw new Error("JIT_BUDGET_EXHAUSTED: no remaining Epic allocation")
  const active_seconds = Math.floor(remaining / remainingWus)
  if (active_seconds < 1) throw new Error("JIT_BUDGET_EXHAUSTED: insufficient remaining Epic allocation")
  const verification_contract = await deriveVerificationContract(root)
  const appendix = `\n\n## Mandate-derived technical execution contract\n\nPlanning estimate only; technical authority is the approved Epic, not an individually owner-approved WU. Preserve all original scope, acceptance and exclusions.\nexecution_contract: ${JSON.stringify({ active_seconds, verification_contract, process_obligations: /\bTDD\s*(?:required|obligatorio)\b/i.test(definition.content) ? [{ kind: "tdd", required: true }] : [] })}\n`
  const compiled = compileWuContract(wuId, {
    ...definition, content: definition.content + appendix,
    source_authority: "MANDATE_DERIVED",
    mandate_source_hash: state.mandate.source_hash,
    origin_source_hash: definition.source_hash,
  })
  // source_hash identifies the *unchanged* archive bytes. Record derived
  // executable metadata separately, not by pretending the archive changed.
  const { contract_hash, ...unsigned } = compiled
  const normalized = { ...unsigned, source_content: definition.content,
    derivation: { kind: "MANDATE_JIT", original_source_hash: definition.source_hash,
      verification_check_ids: verification_contract.commands.map(check => check.id) } }
  return { ...normalized, contract_hash: stableHash(normalized) }
}
