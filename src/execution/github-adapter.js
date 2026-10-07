// Narrow GitHub API adapter for governed merge.
//
// Exposes ONLY getPullRequest, getChecks, and merge — no arbitrary request, no
// URL/API construction from model data, no gh, no One, no shell. The token comes
// from the runtime environment (HARNESS_GITHUB_TOKEN), never from a tool input,
// prompt, artifact, or controller event. Endpoints are hard-coded. `fetchImpl` is
// injectable for tests; `baseUrl` is injectable for a local stub.

const DEFAULT_BASE_URL = "https://api.github.com"

function ghHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "User-Agent": "opencode-agentic-harness",
  }
}

export function createGitHubAdapter({ token = process.env.HARNESS_GITHUB_TOKEN ?? "", baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("GitHub adapter requires a fetch implementation.")
  }

  async function request(method, path, body) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { ...ghHeaders(token), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${res.statusText}`)
    }
    return res.json()
  }

  return {
    // GET /repos/{repository}/pulls/{pr_number}
    async getPullRequest({ repository, pr_number }) {
      const pr = await request("GET", `/repos/${repository}/pulls/${pr_number}`)
      return {
        state: pr.state ?? null, // "open" | "closed"
        merged: pr.merged === true,
        head_sha: pr.head?.sha ?? null,
        base_sha: pr.base?.sha ?? null,
        base_branch: pr.base?.ref ?? null,
        merge_commit_sha: pr.merge_commit_sha ?? null,
      }
    },

    // GET /repos/{repository}/commits/{head_sha}/check-runs → conclusion per named check
    async getChecks({ repository, head_sha, check_names }) {
      const data = await request("GET", `/repos/${repository}/commits/${head_sha}/check-runs`)
      const runs = Array.isArray(data.check_runs) ? data.check_runs : []
      const byName = new Map(runs.map((r) => [
        r.name,
        typeof r.conclusion === "string" ? r.conclusion.toUpperCase() : null,
      ]))
      return check_names.map((name) => ({ name, conclusion: byName.get(name) ?? null }))
    },

    // PUT /repos/{repository}/pulls/{pr_number}/merge, pinning the exact head SHA
    async merge({ repository, pr_number, expected_head_sha }) {
      const merged = await request("PUT", `/repos/${repository}/pulls/${pr_number}/merge`, {
        merge_method: "merge",
        sha: expected_head_sha, // pin the exact reviewed head — never merge a drifted head
      })
      return {
        merged: merged.merged === true,
        merge_commit_sha: merged.sha ?? null,
      }
    },
  }
}
