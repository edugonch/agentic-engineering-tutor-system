// Narrow GitHub merge port (interface + fake).
//
// The concrete adapter (H-WU-06B) implements `getPullRequest` and `merge` over
// `fetch` with hard-coded GET PR / MERGE PR endpoints only. The port exposes
// exactly these two narrow operations — no arbitrary URL/API construction from
// model data, no token, no `gh`, no One, no shell.
//
// `getPullRequest({ repository, pr_number })` →
//   { state: "OPEN"|"MERGED"|"CLOSED", head_sha, base_sha, merged: boolean, merge_commit_sha|null }
//
// `merge({ repository, pr_number })` →
//   { merged: boolean, merge_commit_sha|null }
//
// The fake is used to exercise the merge state machine end-to-end without a
// network side effect.

export function createGitHubMergePort({ getPullRequest, merge }) {
  if (typeof getPullRequest !== "function" || typeof merge !== "function") {
    throw new Error("GitHubMergePort requires getPullRequest and merge functions.")
  }
  return { getPullRequest, merge }
}

// A deterministic fake for tests: the PR is OPEN until `merge` is called, then it
// reports MERGED with a fixed commit and the head that was merged.
export function createFakeMergePort({ headSha = "head-a", baseSha = "base-1", mergeCommitSha = "merge-commit-1" } = {}) {
  let merged = false
  return createGitHubMergePort({
    getPullRequest: async () => ({
      state: merged ? "MERGED" : "OPEN",
      head_sha: headSha,
      base_sha: baseSha,
      merged,
      merge_commit_sha: merged ? mergeCommitSha : null,
    }),
    merge: async () => {
      merged = true
      return { merged: true, merge_commit_sha: mergeCommitSha }
    },
  })
}
