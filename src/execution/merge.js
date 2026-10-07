// Governed merge orchestration. The single public surface is runMergeCandidate,
// exposed to the model as harness_merge_candidate(candidate_id). It resolves
// repository/PR/head/base/policy/CI/review from durable state, consults GitHub
// before any side effect, pins the exact reviewed head, and recovers idempotently
// after a crash (never a second merge).

import { join } from "node:path"
import { readdir } from "node:fs/promises"
import { createExecutionController } from "./execution.js"
import { canStartMerge } from "./state.js"

async function commitMerge(controller, session_id, operation_id, operation_type, body) {
  const lease = await controller.acquire(session_id)
  const snap = await controller.snapshot()
  const res = await controller.commit(
    { operation_id, operation_type, body },
    { holder_session_id: session_id, expected_revision: snap.state.revision, lease_fencing_token: lease.fencing_token },
  )
  return res
}

// Find the execution whose durable state records this candidate. Merge is a rare,
// explicit operation, so scanning controller directories is acceptable here
// (unlike the per-tool-call launch-claim boundary).
async function findExecutionForCandidate(projectRoot, candidate_id) {
  const controllerRoot = join(projectRoot, ".harness", "execution", "controller")
  let entries = []
  try {
    entries = await readdir(controllerRoot, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const execution_id = entry.name
    const controller = await createExecutionController({ dir: join(controllerRoot, execution_id), lease_ttl_ms: 30000 })
    const snap = await controller.snapshot()
    if (snap.state.candidates[candidate_id]) {
      return { controller, execution_id, state: snap.state }
    }
  }
  throw new Error(`No execution records candidate ${candidate_id}.`)
}

export async function runMergeCandidate(projectRoot, { candidate_id, adapter, session_id }) {
  if (!adapter || typeof adapter.getPullRequest !== "function" || typeof adapter.getChecks !== "function" || typeof adapter.merge !== "function") {
    throw new Error("runMergeCandidate requires a GitHubMergePort adapter (getPullRequest/getChecks/merge).")
  }
  if (!session_id) throw new Error("runMergeCandidate requires a session_id.")

  const { controller, execution_id, state } = await findExecutionForCandidate(projectRoot, candidate_id)
  const binding = state.pr_binding
  if (!binding) throw new Error("merge blocked: no PR binding.")
  if (binding.candidate_id !== candidate_id) {
    throw new Error(`merge blocked: candidate ${candidate_id} is not the bound candidate ${binding.candidate_id}.`)
  }

  // Already verified → idempotent no-op.
  if (state.merge?.status === "VERIFIED") return { status: "already_verified", execution_id }

  // A fresh start must pass the durable gate.
  if (!state.merge) {
    const gate = canStartMerge(state)
    if (!gate.allowed) throw new Error(`merge blocked: ${gate.reason}.`)
  }

  const repository = binding.repository
  const pr_number = binding.pr_number

  // 1. Consult GitHub FIRST (always, for both fresh and recovery paths).
  const pr = await adapter.getPullRequest({ repository, pr_number })

  // 2. Verify the exact PR/head/base — any drift fails closed.
  if (pr.head_sha !== binding.head_sha) {
    throw new Error(`merge blocked: PR head ${pr.head_sha} drifted from bound ${binding.head_sha}.`)
  }
  if (pr.base_sha !== binding.base_sha) {
    throw new Error(`merge blocked: PR base ${pr.base_sha} drifted from bound ${binding.base_sha}.`)
  }
  if (pr.base_branch !== binding.base_branch) {
    throw new Error(`merge blocked: PR base branch ${pr.base_branch} drifted from bound ${binding.base_branch}.`)
  }

  // 3. Ensure MERGE_START is durable before either recovery or a fresh merge.
  // (In a fresh run the gate was already checked above; in recovery the merge is
  // already STARTED or RECORDED, so this is a no-op.)
  if (!state.merge) {
    await commitMerge(controller, session_id, `${execution_id}:merge-start`, "MERGE_START", {})
  }

  // 4. Recovery: already merged remotely → record + verify the existing merge.
  if (pr.merged) {
    if (!pr.merge_commit_sha) throw new Error("merge blocked: PR merged but has no merge_commit_sha; fail closed.")
    await commitMerge(controller, session_id, `${execution_id}:merge-record:${pr.merge_commit_sha}`, "MERGE_RECORD", {
      merge_commit_sha: pr.merge_commit_sha,
      merged_head_sha: binding.head_sha,
    })
    await commitMerge(controller, session_id, `${execution_id}:merge-verify`, "MERGE_VERIFY", {})
    return { status: "recovered_existing_merge", execution_id, merge_commit_sha: pr.merge_commit_sha }
  }

  // PR is not merged; it must still be open.
  if (pr.state !== "open") {
    throw new Error(`merge blocked: PR state is ${pr.state}, not open (closed without merge).`)
  }

  // 5. Verify required CI remotely (governance coverage).
  const required = state.mandate?.required_ci_checks ?? []
  if (required.length > 0) {
    const checks = await adapter.getChecks({ repository, head_sha: binding.head_sha, check_names: required })
    for (const c of checks) {
      if (c.conclusion !== "SUCCESS") {
        throw new Error(`merge blocked: required CI ${c.name} conclusion ${c.conclusion ?? "missing"}, not SUCCESS.`)
      }
    }
  }

  // 6. Merge, pinning the exact reviewed head — never a drifted head.
  const merged = await adapter.merge({ repository, pr_number, expected_head_sha: binding.head_sha })
  if (!merged.merged) throw new Error("merge failed: GitHub did not confirm merged=true.")
  if (!merged.merge_commit_sha) throw new Error("merge failed: no merge_commit_sha returned.")

  // 7. MERGE_RECORD (durable).
  await commitMerge(controller, session_id, `${execution_id}:merge-record:${merged.merge_commit_sha}`, "MERGE_RECORD", {
    merge_commit_sha: merged.merge_commit_sha,
    merged_head_sha: binding.head_sha,
  })

  // 8. Re-fetch the PR and verify the merge actually happened on the expected head.
  const after = await adapter.getPullRequest({ repository, pr_number })
  if (!after.merged) throw new Error("merge verify failed: PR not merged after merge call.")
  if (after.head_sha !== binding.head_sha) throw new Error("merge verify failed: merged head drifted.")

  // 9. MERGE_VERIFY (durable).
  await commitMerge(controller, session_id, `${execution_id}:merge-verify`, "MERGE_VERIFY", {})

  return { status: "merged", execution_id, merge_commit_sha: merged.merge_commit_sha }
}
