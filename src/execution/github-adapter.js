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

export function createGitHubAdapter({ token = process.env.HARNESS_GITHUB_TOKEN ?? "", baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("GitHub adapter requires a fetch implementation.")
  }

  async function request(method, path, body) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
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
      const groups = new Map()
      for (let page = 1; ; page++) {
        const data = await request("GET", `/repos/${repository}/commits/${head_sha}/check-runs?per_page=100&page=${page}`)
        const runs = Array.isArray(data.check_runs) ? data.check_runs : []
        for (const run of runs) {
          if (run.head_sha && run.head_sha !== head_sha) continue
          const key = `${run.name}:${run.app?.id ?? "unknown"}`
          const prior = groups.get(key)
          if (!prior || (Number(run.id) || 0) > (Number(prior.id) || 0)) groups.set(key, run)
        }
        if (runs.length < 100) break
        if (page >= 100) throw new Error("CI pagination exceeds safety bound; result incomplete.")
      }
      const statuses = new Map()
      // Legacy commit-status contexts are an independent CI surface. Read them
      // alongside check-runs; ambiguity never passes.
      if (check_names.length) {
        for (let page = 1; ; page++) {
          const data = await request("GET", `/repos/${repository}/commits/${head_sha}/statuses?per_page=100&page=${page}`)
          const rows = Array.isArray(data) ? data : []
          for (const row of rows) {
            const prior = statuses.get(row.context)
            if (!prior || Number(row.id) > Number(prior.id)) statuses.set(row.context, row)
          }
          if (rows.length < 100) break
          if (page >= 100) throw new Error("CI status pagination exceeds safety bound; result incomplete.")
        }
      }
      return check_names.map(name => {
        const matches = [...groups.values()].filter(r => r.name === name)
        // Multiple apps with the same name are ambiguous, never last-wins.
        const run = matches.length === 1 && !statuses.has(name) ? matches[0] : null
        return { name, conclusion: run && (!run.status || run.status === "completed") ? run.conclusion ?? null : matches.length === 0 ? statuses.get(name)?.state ?? null : null,
          run_id: run?.id ?? null, app_id: run?.app?.id ?? null }
      })
    },

    async getCommitTree({ repository, head_sha }) {
      const commit = await request("GET", `/repos/${repository}/git/commits/${head_sha}`)
      return commit.tree?.sha ?? null
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
