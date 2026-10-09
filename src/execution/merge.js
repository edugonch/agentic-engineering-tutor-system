// Governed merge orchestration. The single public surface is runMergeCandidate,
// exposed to the model as harness_merge_candidate(candidate_id). It resolves
// repository/PR/head/base/policy/CI/review from durable state, consults GitHub
// before any side effect, pins the exact reviewed head, and recovers idempotently
// after a crash (never a second merge).

import { join } from "node:path"
import { readdir } from "node:fs/promises"
import { createExecutionController } from "./execution.js"
import { createCandidateRegistry } from "./candidate-registry.js"
import { candidateGitTree } from "./git-tree.js"
import { canStartMerge, canVerifyExternalMerge } from "./state.js"
import { ExternalWaitError } from "./external-errors.js"

function isSuccessConclusion(value) {
  return typeof value === "string" && value.toUpperCase() === "SUCCESS"
}

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
export async function findExecutionForCandidate(projectRoot, candidate_id) {
  const controllerRoot = join(projectRoot, ".harness", "execution", "controller")
  let entries = []
  try {
    entries = await readdir(controllerRoot, { withFileTypes: true })
  } catch {
    entries = []
  }
  const matches = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const execution_id = entry.name
    const controller = await createExecutionController({ dir: join(controllerRoot, execution_id), lease_ttl_ms: 30000 })
    const snap = await controller.snapshot()
    if (snap.state.candidates[candidate_id]) {
      matches.push({ controller, execution_id, state: snap.state })
    }
  }
  if (matches.length === 0) throw new Error(`No execution records candidate ${candidate_id}.`)
  if (matches.length > 1) {
    throw new Error(`Ambiguous execution ownership: candidate ${candidate_id} is recorded in ${matches.length} executions; fail closed.`)
  }
  return matches[0]
}

export async function runMergeCandidate(projectRoot, { candidate_id, adapter, session_id }) {
  if (!adapter || typeof adapter.getPullRequest !== "function" || typeof adapter.getChecks !== "function" || typeof adapter.merge !== "function") {
    throw new Error("runMergeCandidate requires a GitHubMergePort adapter (getPullRequest/getChecks/merge).")
  }
  if (!session_id) throw new Error("runMergeCandidate requires a session_id.")

  const execution = await findExecutionForCandidate(projectRoot, candidate_id)
  const { controller, execution_id } = execution
  let state = execution.state
  const binding = state.pr_binding
  if (!binding) throw new Error("merge blocked: no PR binding.")
  if (binding.candidate_id !== candidate_id) {
    throw new Error(`merge blocked: candidate ${candidate_id} is not the bound candidate ${binding.candidate_id}.`)
  }

  // Already verified → idempotent no-op.
  if (state.merge && state.merge.candidate_id !== candidate_id) throw new Error("merge blocked: merge belongs to a different candidate.")
  if (state.merge?.status === "VERIFIED") return { status: "already_verified", execution_id }

  // A fresh start must pass the durable gate.
  if (!state.merge || (state.merge.status === "STARTED" && !state.blocker)) {
    let gate = canStartMerge(state)
    // CI is an observable external fact: refresh it directly, rather than
    // requiring the model to translate a pending/absent receipt into SUCCESS.
    if (!gate.allowed && gate.reason.startsWith("required CI ")) {
      const checks = await adapter.getChecks({ repository: binding.repository, head_sha: binding.head_sha, check_names: state.mandate.required_ci_checks })
      for (const name of state.mandate.required_ci_checks) {
        const check = checks.find(c => c.name === name) ?? { name }
        const raw = String(check.conclusion).toUpperCase()
        const conclusion = raw === "SUCCESS" ? "SUCCESS" : check.pending || raw === "PENDING" ? "PENDING" : ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(raw) ? "FAILURE" : "ERROR"
        const prior = state.ci_evidence[candidate_id]?.[name]
        if (prior?.conclusion !== conclusion || prior?.head_sha !== binding.head_sha || prior?.binding_at_revision !== binding.at_revision) {
          await commitMerge(controller, session_id, `${execution_id}:remote-ci:${state.revision}:${name}`, "RECORD_CI", {
            candidate_id, head_sha: binding.head_sha, check_identity: name, conclusion, binding_at_revision: binding.at_revision,
            evidence_ref: JSON.stringify({ source: "github.adapter", run_id: check.run_id ?? null, app_id: check.app_id ?? null }) })
          state = (await controller.snapshot()).state
        }
      }
      gate = canStartMerge(state)
      if (!gate.allowed && /^required CI .* conclusion is PENDING/.test(gate.reason)) throw new ExternalWaitError("CI_PENDING", gate.reason)
    }
    if (!gate.allowed) throw new Error(`merge blocked: ${gate.reason}.`)
  }

  const attempt = state.merge?.attempt_id ?? state.merge?.started_at_revision ?? state.revision
  const attemptKey = `${execution_id}:${candidate_id}:merge:${attempt}`
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

  // 4. Recovery: already merged remotely.
  if (pr.merged) {
    if (!state.merge) {
      await verifyCandidateTree(projectRoot, candidate_id, adapter, binding)
      await commitMerge(controller, session_id, `${attemptKey}:start`, "MERGE_START", { attempt_id: attempt })
    }
    if (!pr.merge_commit_sha) throw new Error("merge blocked: PR merged but has no merge_commit_sha; fail closed.")
    // RECORDED means the merge was recorded before a crash (between MERGE_RECORD
    // and MERGE_VERIFY). Validate the remote merge commit against the durable
    // record, then verify only — never record again.
    if (state.merge?.status === "RECORDED") {
      if (state.merge.merge_commit_sha !== pr.merge_commit_sha) {
        throw new Error(`merge verify failed: remote merge commit ${pr.merge_commit_sha} differs from recorded ${state.merge.merge_commit_sha}.`)
      }
      await commitMerge(controller, session_id, `${attemptKey}:verify`, "MERGE_VERIFY", {})
      return { status: "recovered_existing_merge", execution_id, merge_commit_sha: pr.merge_commit_sha }
    }
    // STARTED (or a fresh run that just committed MERGE_START above): record the
    // existing remote merge, then verify.
    await commitMerge(controller, session_id, `${attemptKey}:record:${pr.merge_commit_sha}`, "MERGE_RECORD", {
      merge_commit_sha: pr.merge_commit_sha,
      merged_head_sha: binding.head_sha,
    })
    await commitMerge(controller, session_id, `${attemptKey}:verify`, "MERGE_VERIFY", {})
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
    for (const name of required) {
      const c = checks.find(c => c.name === name) ?? { name, conclusion: null }
      if (!isSuccessConclusion(c.conclusion)) {
        if (c.pending || String(c.conclusion).toUpperCase() === "PENDING") throw new ExternalWaitError("CI_PENDING", `Required CI ${c.name} is pending on ${binding.head_sha}`)
        throw new Error(`merge blocked: required CI ${c.name} conclusion ${c.conclusion ?? "missing"}, not SUCCESS.`)
      }
    }
  }

  // 6. Merge, pinning the exact reviewed head — never a drifted head.
  const tree_sha = await verifyCandidateTree(projectRoot, candidate_id, adapter, binding)
  if (!state.merge) {
    await commitMerge(controller, session_id, `${attemptKey}:start`, "MERGE_START", { tree_sha, attempt_id: attempt })
  }
  const fresh = await controller.snapshot()
  const merged = await controller.guardedEffect({
    holder_session_id: session_id,
    expected_revision: fresh.state.revision,
    validate(current) {
      const gate = canStartMerge(current)
      if (!gate.allowed) throw new Error(`merge blocked: ${gate.reason}.`)
      if (JSON.stringify(current.pr_binding) !== JSON.stringify(binding)) throw new Error("PR binding changed before merge.")
    },
    effect: async () => {
      // Another same-session invocation may have finished the remote effect
      // while this call waited for the mutex. Observe before issuing it again.
      const latest = await adapter.getPullRequest({ repository, pr_number })
      if (latest.head_sha !== binding.head_sha || latest.base_branch !== binding.base_branch) throw new Error("PR drifted immediately before merge")
      if (latest.merged) {
        if (!latest.merge_commit_sha) throw new Error("Merged PR has no commit identity")
        return { merged: true, merge_commit_sha: latest.merge_commit_sha }
      }
      if (latest.state !== "open" || latest.base_sha !== binding.base_sha) throw new Error("PR base/state drifted immediately before merge")
      return adapter.merge({ repository, pr_number, expected_head_sha: binding.head_sha })
    },
  })
  if (!merged.merged) throw new Error("merge failed: GitHub did not confirm merged=true.")
  if (!merged.merge_commit_sha) throw new Error("merge failed: no merge_commit_sha returned.")

  // 7. MERGE_RECORD (durable).
  await commitMerge(controller, session_id, `${attemptKey}:record:${merged.merge_commit_sha}`, "MERGE_RECORD", {
    merge_commit_sha: merged.merge_commit_sha,
    merged_head_sha: binding.head_sha,
  })

  // 8. Re-fetch the PR and verify the merge actually happened on the expected head
  // with the exact recorded merge commit.
  const after = await adapter.getPullRequest({ repository, pr_number })
  if (!after.merged) throw new Error("merge verify failed: PR not merged after merge call.")
  if (after.head_sha !== binding.head_sha) throw new Error("merge verify failed: merged head drifted.")
  if (after.merge_commit_sha !== merged.merge_commit_sha) throw new Error(`merge verify failed: remote merge commit ${after.merge_commit_sha} differs from recorded ${merged.merge_commit_sha}.`)

  // 9. MERGE_VERIFY (durable).
  await commitMerge(controller, session_id, `${attemptKey}:verify`, "MERGE_VERIFY", {})

  return { status: "merged", execution_id, merge_commit_sha: merged.merge_commit_sha }
}

// Human-policy external merge verification. The Harness observes an already-
// performed merge: it uses the adapter's getPullRequest/getChecks only, never
// merge(). Never enters STARTED; the state goes null → RECORDED(source=HUMAN_
// EXTERNAL) → VERIFIED. Recovers idempotently from RECORDED.
export async function runVerifyExternalMerge(projectRoot, { candidate_id, adapter, session_id }) {
  if (!adapter || typeof adapter.getPullRequest !== "function" || typeof adapter.getChecks !== "function") {
    throw new Error("runVerifyExternalMerge requires a GitHub adapter (getPullRequest/getChecks).")
  }
  if (!session_id) throw new Error("runVerifyExternalMerge requires a session_id.")

  const { controller, execution_id, state } = await findExecutionForCandidate(projectRoot, candidate_id)
  const binding = state.pr_binding
  if (!binding) throw new Error("external merge blocked: no PR binding.")
  if (binding.candidate_id !== candidate_id) {
    throw new Error(`external merge blocked: candidate ${candidate_id} is not the bound candidate ${binding.candidate_id}.`)
  }

  // Already verified → idempotent no-op.
  if (state.merge && state.merge.candidate_id !== candidate_id) throw new Error("merge blocked: merge belongs to a different candidate.")
  if (state.merge?.status === "VERIFIED") return { status: "already_verified", execution_id }

  // A fresh start must pass the human gate.
  if (!state.merge) {
    const gate = canVerifyExternalMerge(state)
    if (!gate.allowed) throw new Error(`external merge blocked: ${gate.reason}.`)
  }

  const repository = binding.repository
  const pr_number = binding.pr_number

  // 1. Consult GitHub.
  const pr = await adapter.getPullRequest({ repository, pr_number })

  // 2. Require an already-merged PR on the exact head/branch with a merge commit.
  if (!pr.merged) throw new Error("external merge blocked: PR is not merged.")
  if (pr.head_sha !== binding.head_sha) throw new Error(`external merge blocked: PR head ${pr.head_sha} drifted from bound ${binding.head_sha}.`)
  if (pr.base_branch !== binding.base_branch) throw new Error(`external merge blocked: PR base branch ${pr.base_branch} drifted from bound ${binding.base_branch}.`)
  if (!pr.merge_commit_sha) throw new Error("external merge blocked: PR has no merge_commit_sha.")

  await verifyCandidateTree(projectRoot, candidate_id, adapter, binding)

  // 3. Required CI (if governance declares it), on the exact head.
  const required = state.mandate?.required_ci_checks ?? []
  if (required.length > 0) {
    const checks = await adapter.getChecks({ repository, head_sha: binding.head_sha, check_names: required })
    for (const name of required) {
      const c = checks.find(c => c.name === name) ?? { name, conclusion: null }
      if (!isSuccessConclusion(c.conclusion)) {
        if (c.pending || String(c.conclusion).toUpperCase() === "PENDING") throw new ExternalWaitError("CI_PENDING", `Required CI ${c.name} is pending on ${binding.head_sha}`)
        throw new Error(`external merge blocked: required CI ${c.name} conclusion ${c.conclusion ?? "missing"}, not SUCCESS.`)
      }
    }
  }

  // 4. Recovery from RECORDED → verify only; else record + verify.
  if (state.merge?.status === "RECORDED") {
    if (state.merge.merge_commit_sha !== pr.merge_commit_sha) {
      throw new Error(`external merge verify failed: remote merge commit ${pr.merge_commit_sha} differs from recorded ${state.merge.merge_commit_sha}.`)
    }
    await commitMerge(controller, session_id, `${execution_id}:${candidate_id}:merge-verify`, "MERGE_VERIFY", {})
    return { status: "verified_external_merge", execution_id, merge_commit_sha: pr.merge_commit_sha }
  }

  // 5. null → MERGE_EXTERNAL_RECORD → MERGE_VERIFY (never STARTED, never merge()).
  await commitMerge(controller, session_id, `${execution_id}:${candidate_id}:merge-external-record:${pr.merge_commit_sha}`, "MERGE_EXTERNAL_RECORD", {
    merge_commit_sha: pr.merge_commit_sha,
    merged_head_sha: binding.head_sha,
    observed_base_sha: pr.base_sha ?? null,
  })
  await commitMerge(controller, session_id, `${execution_id}:${candidate_id}:merge-verify`, "MERGE_VERIFY", {})

  return { status: "verified_external_merge", execution_id, merge_commit_sha: pr.merge_commit_sha }
}

async function verifyCandidateTree(projectRoot, candidateId, adapter, binding) {
  if (typeof adapter.getCommitTree !== "function") throw new Error("merge blocked: adapter cannot verify candidate Git tree.")
  const registry = createCandidateRegistry({ dir: join(projectRoot, ".harness", "execution") })
  const candidate = await registry.load(candidateId)
  if (!candidate) throw new Error("merge blocked: frozen candidate missing.")
  const expected = candidateGitTree(candidate)
  const observed = await adapter.getCommitTree({ repository: binding.repository, head_sha: binding.head_sha })
  if (observed !== expected) throw new Error(`merge blocked: candidate Git tree ${expected} differs from remote ${observed}.`)
  return expected
}

// Read-only external progress fingerprint, used before the no-progress guard.
export async function observeMergeProgress(projectRoot, candidate_id, adapter) {
  const { state } = await findExecutionForCandidate(projectRoot, candidate_id)
  const binding = state.pr_binding
  if (!binding) return { binding: null }
  return {
    binding, blocker: state.blocker, review: state.reviews[candidate_id],
    pr: await adapter.getPullRequest({ repository: binding.repository, pr_number: binding.pr_number }),
    checks: await adapter.getChecks({ repository: binding.repository, head_sha: binding.head_sha, check_names: state.mandate?.required_ci_checks ?? [] }),
  }
}

export async function runRebindPR(projectRoot, { candidate_id, adapter, session_id }) {
  const { controller, execution_id, state } = await findExecutionForCandidate(projectRoot, candidate_id)
  const binding = state.pr_binding
  if (!binding || binding.candidate_id !== candidate_id || state.merge) throw new Error("Rebind requires the currently bound candidate with no unresolved merge")
  const pr = await adapter.getPullRequest(binding)
  if (pr.state !== "open" || pr.merged) throw new Error("Rebind requires an open unmerged PR")
  const next = { repository: binding.repository, pr_number: binding.pr_number, candidate_id,
    head_sha: pr.head_sha, base_sha: pr.base_sha, base_branch: pr.base_branch }
  const tree_sha = await verifyCandidateTree(projectRoot, candidate_id, adapter, next)
  const lease = await controller.acquire(session_id)
  await controller.commit({ operation_id: `${execution_id}:rebind:${state.revision}`, operation_type: "BIND_PR",
    body: { ...next, revalidated: true, tree_sha } }, { holder_session_id: session_id, expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  return { status: "rebound", binding: next, tree_sha, next_action: "Record fresh exact-head CI evidence before merge" }
}

export async function runAbortMerge(projectRoot, { candidate_id, adapter, session_id }) {
  const { controller, execution_id, state } = await findExecutionForCandidate(projectRoot, candidate_id)
  if (state.merge?.status !== "STARTED" || state.merge.candidate_id !== candidate_id) throw new Error("No STARTED attempt to abort")
  const binding = state.pr_binding
  const pr = await adapter.getPullRequest(binding)
  if (pr.merged) return runMergeCandidate(projectRoot, { candidate_id, adapter, session_id })
  if (pr.state !== "closed" || pr.head_sha !== binding.head_sha) throw new Error("An open or drifted PR cannot prove an ambiguous merge was cancelled; inspect/recover the existing attempt")
  const lease = await controller.acquire(session_id)
  await controller.commit({ operation_id: `${execution_id}:merge-abort:${state.merge.started_at_revision}`, operation_type: "MERGE_ABORT",
    body: { candidate_id, observed_state: "closed", observed_merged: false, evidence_ref: `${binding.repository}#${binding.pr_number}@${pr.head_sha}` } },
    { holder_session_id: session_id, expected_revision: state.revision, lease_fencing_token: lease.fencing_token })
  return { status: "aborted", next_action: "Bind a reviewed replacement candidate and PR; prior attempt retained" }
}
