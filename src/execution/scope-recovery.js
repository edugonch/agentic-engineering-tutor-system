// Exact, read-only proof that a legacy BLOCKED_SCOPE was a stale-checkout
// discrepancy, not an unauthorized change in the active WU's approved scope.
// Never auto-clear BLOCKED_SCOPE based on model prose or a CHECKPOINT.
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { lstat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { assertCandidatePath } from "./candidate.js"

const exec = promisify(execFile)
const hashBytes = bytes => createHash("sha256").update(bytes).digest("hex")
const shaPattern = /^[a-f0-9]{40}$/
// The legacy BLOCK event has no typed cause. Treat prose as *triage evidence*,
// never as proof that Git or a user-approved scope decision changed.
const legacyEnvironmentClaim = /(?:\\buntracked\\b|\\bnot[ -]tracked\\b|\\bnot in git\\b|\\bmissing from (?:git|branch|checkout)\\b|\\bworktree\\b|\\bworking[ -]tree\\b|\\bstale\\b|predecessor.{0,70}(?:hash|tree|commit|mismatch)|baseline.{0,40}(?:mismatch|drift))/i
const actualScopeClaim = /(?:new (?:feature|requirement|policy|scope)|unauthori[sz]ed (?:change|scope|feature)|scope (?:expansion|increase)|out.of.scope (?:feature|implementation)|additional (?:feature|service|module|endpoint)|change (?:business|product) policy)/i

export function classifyScopeBlocker(blocker) {
  if (blocker?.class !== "BLOCKED_SCOPE") return { kind: "NOT_SCOPE", reason: "No scope blocker is active" }
  if (blocker.authority_question) {
    return { kind: "SCOPE_CONFLICT", reason: "An explicit structured authority question cannot be resolved by Git checkout repair" }
  }
  const reason = String(blocker.reason ?? "")
  if (actualScopeClaim.test(reason)) {
    return { kind: "SCOPE_CONFLICT", reason: "Blocker explicitly asserts functional scope expansion; requires separate owner authority" }
  }
  if (!legacyEnvironmentClaim.test(reason)) {
    return { kind: "EVIDENCE_REQUIRED", reason: "Legacy BLOCKED_SCOPE cause is not typed and lacks a recognizable checkout/predecessor evidence claim" }
  }
  return { kind: "LEGACY_CHECKOUT_CLAIM", reason: "Possible historical environment mismatch; only exact Git/candidate proof may permit reconciliation" }
}

export const isStaleWorktreeScopeBlocker = blocker => classifyScopeBlocker(blocker).kind === "LEGACY_CHECKOUT_CLAIM"

async function git(root, args) {
  const { stdout } = await exec("git", args, { cwd: root, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })
  return stdout.trim()
}

function verifiedMerge(state, candidateId) {
  const merge = state.merge?.candidate_id === candidateId ? state.merge : state.merges?.[candidateId]
  if (!merge || merge.status !== "VERIFIED" || !shaPattern.test(merge.merge_commit_sha ?? "")) {
    throw new Error("SCOPE_RECOVERY_PREDECESSOR_MERGE: prior completed candidate lacks verified merge commit")
  }
  return merge
}

export async function inspectStaleWorktreeScope(root, state, registry) {
  const blocker = state.blocker
  if (!isStaleWorktreeScopeBlocker(blocker)) throw new Error("SCOPE_RECOVERY_CAUSE: only a legacy stale-worktree BLOCKED_SCOPE is eligible")
  if (state.completed || !state.wu || state.wu.completed ||
      state.mandate?.authority_kind !== "OWNER_APPROVED_EPIC" ||
      !Array.isArray(state.mandate.wu_sequence)) {
    throw new Error("SCOPE_RECOVERY_STATE: active frozen WU and approved incomplete mandate required")
  }
  if (state.mandate.wu_sequence[state.activated_wu_ids.length - 1] !== state.wu.wu_id) {
    throw new Error("SCOPE_RECOVERY_ORDER: active WU differs from frozen sequence")
  }
  if (state.budget.active_phase || state.external_wait || state.verification_phase ||
      Object.values(state.dispatches).some(d => !["released", "result_reconciled"].includes(d.status))) {
    throw new Error("SCOPE_RECOVERY_ACTIVE: unsettled work or external integration prevents reconciliation")
  }
  if (Object.values(state.candidates).some(c => c.wu_id === state.wu.wu_id) ||
      state.pr_binding?.candidate_id && state.candidates[state.pr_binding.candidate_id]?.wu_id === state.wu.wu_id) {
    throw new Error("SCOPE_RECOVERY_ACTIVE: current WU already has a frozen candidate or PR")
  }

  const predecessors = state.mandate.wu_sequence.slice(0, -1)
  const activeIndex = state.activated_wu_ids.length - 1
  const completed = predecessors.slice(0, activeIndex)
  if (!completed.length) throw new Error("SCOPE_RECOVERY_PREDECESSOR: verified predecessor required")
  if (completed.some(wu => !state.completed_wus?.[wu]?.candidate_id)) {
    throw new Error("SCOPE_RECOVERY_PREDECESSOR: missing durable completion")
  }
  // The checkout must be *exactly* the merge of the immediately preceding WU.
  // Do not claim equivalence to an arbitrary HEAD or merely matching filenames.
  const lastCandidate = state.completed_wus[completed.at(-1)].candidate_id
  const lastMerge = verifiedMerge(state, lastCandidate)
  const head = await git(root, ["rev-parse", "HEAD"])
  if (head !== lastMerge.merge_commit_sha) {
    throw new Error("SCOPE_RECOVERY_HEAD: Git HEAD differs from the last verified predecessor merge")
  }
  // Any tracked modification (including staged/deleted/renamed paths) is a
  // real workspace discrepancy; preserve local edits, never reset or clean.
  if (await git(root, ["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("SCOPE_RECOVERY_DIRTY: tracked files differ from verified merge; preserve them")
  }

  const files = new Map()
  for (const wu of completed) {
    const id = state.completed_wus[wu].candidate_id
    // Historical completed predecessors can have their merge pointer superseded
    // by a later binding. Their durable WU_COMPLETE is retained; only the last
    // predecessor needs an independently retained VERIFIED merge SHA for HEAD.
    const candidate = await registry.load(id)
    if (!candidate || candidate.candidate_id !== id ||
        !candidate.overlay || !Array.isArray(candidate.overlay)) {
      throw new Error("SCOPE_RECOVERY_CANDIDATE: completed candidate unavailable or corrupt")
    }
    for (const entry of candidate.overlay) {
      const path = assertCandidatePath(entry.path)
      if (entry.type !== "file" || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
        throw new Error("SCOPE_RECOVERY_CANDIDATE: predecessor contains unsupported entry")
      }
      // Later approved predecessors may intentionally supersede earlier files.
      files.set(path, { wu, sha256: entry.sha256 })
    }
    for (const path of candidate.deletions ?? []) files.delete(assertCandidatePath(path))
  }
  if (!files.size) throw new Error("SCOPE_RECOVERY_CANDIDATE: no predecessor output files to verify")
  const proof = []
  for (const [path, expected] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    await git(root, ["ls-files", "--error-unmatch", "--", path])
    const info = await lstat(join(root, path))
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("SCOPE_RECOVERY_FILE: predecessor output is not a regular file")
    const observed = hashBytes(await readFile(join(root, path)))
    if (observed !== expected.sha256) throw new Error(`SCOPE_RECOVERY_FILE: predecessor output differs: ${path}`)
    proof.push({ path, source_wu_id: expected.wu, sha256: observed })
  }
  // Re-observe Git after content reads. No controller mutation is performed by
  // this function; the controller's CAS/lease independently guards state drift.
  if (await git(root, ["rev-parse", "HEAD"]) !== head ||
      await git(root, ["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("SCOPE_RECOVERY_RACE: checkout changed during inspection")
  }
  return {
    kind: "VERIFIED_PREDECESSOR_WORKTREE", checkout_root: root, wu_id: state.wu.wu_id,
    blocked_at_revision: blocker.at_revision, head_sha: head,
    predecessor_candidate_id: lastCandidate, predecessor_merge_sha: lastMerge.merge_commit_sha,
    predecessor_files: proof,
  }
}
