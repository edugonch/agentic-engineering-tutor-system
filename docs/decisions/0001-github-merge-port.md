# ADR-001 — GitHubMergePort: narrow, credential-isolated governed merge

- Status: ACCEPTED (independent review PASS 5/5, merged via PR #14)
- Date: 2026-10-06
- Affects: Harness governed merge (H-WU-06, H-WU-07)

## Context

The Harness's execution control plane (V1, Phase 3) governs Work Units up to
candidate freeze, independent review, and `WU_COMPLETE`. It does not integrate
with GitHub. To support `governed_auto` merge policy, the plugin must be able to
merge an already-reviewed PR without granting the model arbitrary shell or
GitHub authority.

The WU-058 incident reinforced that any per-turn guard is a false-stop risk and
that the control plane must distinguish real authority from instrumentation.
Merging is an irreversible, external side effect, so it must be treated as a
narrow, governed operation — not a free-form model action.

## Decision

Introduce a narrow **GitHubMergePort** inside the plugin:

```
model ──(request: merge candidate X)──▶ harness_merge_candidate
                                          │
                                          ▼
                              controller durable state (governed)
                                          │
                                          ▼
                                   GitHubMergePort
                                          │
                                          ▼
                                 GitHub API adapter
```

The model only ever requests `merge candidate X`. The plugin resolves everything
else from durable controller state — never from the model prompt:

- `repository`, `pr_number`, `candidate_id`, `head_sha`, `base_sha`, `base_branch`
  from the `BIND_PR` record;
- independent review `PASS` + exact candidate/head hashes from `RECORD_REVIEW`;
- exact-head CI `SUCCESS` from `RECORD_CI`;
- `merge_policy ∈ {governed_auto, human, none}` from approved project governance.

The adapter receives only the narrow operation it needs (e.g. "merge PR N in repo
R"), not an arbitrary GitHub request.

### Credential isolation

Credentials live in the operator/runtime environment and flow directly to the
adapter. They **never** appear in the prompt, any knowledge artifact, or any
controller event. The model has no path to a token.

### Explicit non-goals

- No `shell:*` for merge (the orchestrator already runs with shell denied).
- No `one`/One CLI dependency for GitHub operations (One remains for external
  authorities such as Drive, not for GitHub merge).
- No arbitrary GitHub request controlled by the model.
- No automatic production deploy/migration/secret access (unchanged from
  `production-safety`).

## Consequences

- The model cannot run `gh pr merge`, cannot construct arbitrary GitHub API
  calls, and cannot touch credentials.
- Merge is idempotent at the port: the adapter asks GitHub for the current PR
  state and records an existing merge rather than blindly retrying.
- A new operation/tool (`harness_merge_candidate` + merge state) is required; the
  merge policy and its preconditions are the subject of H-WU-06/H-WU-07.
- This ADR does not by itself authorize any merge behavior; the executor and
  policy remain unimplemented until their own review.
