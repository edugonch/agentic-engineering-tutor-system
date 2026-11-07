# Orphaned builder recovery and runtime stability (Harness)

## What this revision guarantees

- A child with only unfinished native `read`, exact `pwd`, exact project-root `cd && pwd`, or the existing narrowly validated `grep -n` forms can pass read-only tool classification. It is **not** treated as completed.
- An owner-approved abandonment decision still must bind the **exact** execution, active WU, dispatch and child session. Read-only eligibility never replaces owner authority or runtime corroboration.
- Every successful recovery still requires the live root orchestrator, child/parent/project identity, repeatable quiescence, acknowledged interruption, durable fencing, a fresh post-fence observation, and conservative reservation accounting.
- After two **durably abandoned/reconciled** builders in the same active WU, the runtime plugin temporarily refuses another `prepare_launch` for a builder until it has had 30 continuous minutes since plugin setup **and** 30 minutes have elapsed since the last abandonment fence. It does not block reviewers, alter prior journal entries, or change authority/budget. In-process instability is not falsely described as an OS restart.
- A refusal happens **before the new launch claim**. A reservation that was created beforehand must be released through the normal `release` controller action when it is provably never launched. This is not an orphan abandonment.
- `operational_status.runtime_stability` exposes the count and conservatively charged seconds for interrupted builders and the remaining local stability window when called through the loaded plugin. `operational_status.time_policy` reports whether the hard per-dispatch timer applies. `harness_check_agent_readiness.runtime_continuity` exposes process/plugin boot observations so two calls can be compared.

## What this does not claim

- A single runtime observation cannot prove OpenCode restarted. Check process logs and two runtime-continuity observations. A builder stopped at an exact 1800-second reservation is not automatically proof of a restart: `legacy_hard_limit` mode can enforce that cutoff; `WU_PLANNING_ESTIMATES` should not.
- A plugin code update does not automatically update running OpenCode processes. Do not reload during active builders; install at a quiescent boundary.
- This revision does not grant standing owner authority to abandon future dispatches. Without an exact APPROVED decision for the new child, abandonment remains refused.
- No recovery path may invent a terminal result, mark pending shell mutations harmless, clear an unrelated blocker, or call a review/CI/merge PASS.

## Operator flow

1. Read the current durable `operational_status` and runtime readiness. Confirm `time_policy` and actual session liveness.
2. If there is a launched orphan, inspect its handoff once. Confirm no pending mutating tools. If an exact approved decision exists, attempt governed recovery once.
3. On `ABANDONED_RECONCILED`, verify and clear only the corresponding tooling stop using the controller, preserve partial code and continue the same active WU.
4. If `RUNTIME_STABILITY_GUARD` stops a *new* builder, release only its never-launched reservation and allow the measured stability window to pass. Diagnose host restarts and explicit worker limits instead of repeatedly attempting new builders.
5. Once the runtime is stable, resume the same existing WU, finish verification, independent review and governed merge. Only then configure the next explicit owner-approved ten-WU batch.

## Optional owner-approved automatic orphan recovery

By default, no auto-abandon occurs. Automatic recovery requires a newly recorded indexed, hash-verified owner-approved `decision` artifact with a typed policy, AND explicit host opt-in. No Epic/WU budget increase is implied.

Policy line in the exact decision content (replace the date with a real UTC ISO timestamp within 7 days):

`orphan_recovery_policy: {"action":"RECOVER_READ_ONLY_ORPHANS","execution_id":"alfran-epic05-delivery","wu_id":"E05-27-E","max_dispatches":2,"max_reserved_seconds":3600,"expires_at":"2026-11-10T00:00:00Z"}`

Limits: 1–3 recoveries, 1–5400 reserved seconds, expiry at most 7 days away. Unindexed/unapproved, malformed, duplicate-field, SHA-mismatched, expired, or wrong-WU decisions are rejected. Existing exact-dispatch abandonment decisions continue to work without change.

**Explicit activation:** set `HARNESS_AUTONOMOUS_ORPHAN_POLICY_ID` in the OpenCode host environment to the exact approved decision artifact ID. Activate only at a quiescent restart boundary, never during a live builder. Omitting the variable disables automatic orphan recovery. The setting is read at plugin startup.

When enabled, the supervisor attempts governed recovery only if one exact builder is launched for the active WU, a `BLOCKED_TOOLING` stop exists, and the root orchestrator is proven succeeded. It checks the policy scope, expiry, amount already fenced against this policy and remaining cap. Runtime child/parent identity, quiescence, acknowledged interrupt, durable fencing and conservative reservation charging remain mandatory. An abandoned dispatch never counts as successful work; a blocker is not automatically cleared.

An auto-recovery refusal records a non-authoritative `ORPHAN_AUTO_TRIAGE` event scoped to the exact dispatch, policy and durable progress. It never grants more authority or relaunches a builder. An unchanged state cannot trigger a repeated identical recovery after a supervisor restart.

The plugin cannot repair an unstable OpenCode host or missing runtime session capabilities. Continue investigating host restarts and `time_policy` separately. The policy does not authorize future WUs or unknown shell effects.
