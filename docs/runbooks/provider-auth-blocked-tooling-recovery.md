# Provider authentication stop — OpenCode Harness recovery runbook

Applies to an active `BLOCKED_TOOLING` caused by a real OpenCode `provider.auth` / expired credential error. This is **not** the immutable verification setup-timeout case. Do not invoke `harness_retry_blocked_verification` for an expired API key.

## 1. Preserve evidence first

In the exact local worktree used by the root orchestrator, capture `git status --short`, `git rev-parse HEAD`, `git worktree list --porcelain`, and a **private** byte-for-byte backup with hashes of the controller directory, candidate registry and handoffs. Never publish a ledger containing patient data, tokens or private credentials. Controller reads:

- `harness_execution_controller(action="status", execution_id="alfran-epic05-delivery")`
- `harness_execution_controller(action="audit_recovery", execution_id="alfran-epic05-delivery")`
- `harness_execution_controller(action="verify", execution_id="alfran-epic05-delivery")`

Capture **current** blocker class/revision, WU identity, reconciliation state and available WU/Epic budget. Historical report: `E05-04-E`, `e0504-repair-1` reconciled, `BLOCKED_TOOLING` at revision 548; these are **not** substitutes for current local observations.

The controller `provider_auth_triage` field is read-only; `ELIGIBLE_FOR_PROBE` is **not** permission to clear a blocker.

## 2. Restore provider credentials out of band

From the target OpenCode environment, inspect only model names and provider identities (sanitize ALL output before sharing):

```sh
opencode --version
opencode plugin list
opencode models
opencode auth list
opencode debug config
```

Verify the effective `agents.harness-builder.model` and `agents.harness-reviewer.model`, and the plugin SHA actually loaded in the running server. OpenCode V2 uses `agents` (plural); older v1 documentation used `agent`. Agent inventory alone does not authenticate the model.

Renew the affected provider in the authorized OpenCode credential store, for example via `opencode auth login`, or choose an explicitly authorized alternative model; never paste/store keys in a git project. Restart or reload the **actual server process in use** through its normal lifecycle. Do not assume that `opencode service restart` exists.

With the exact Builder model, run one minimal cost-bounded canary *outside the governed WU and without tools*:

```sh
opencode run --model 'provider/model-id' 'Reply with AUTH_OK only. Do not call tools.'
```

Repeat for Reviewer. Record redacted identity, outcome and timestamp; a correct string alone is **not** a cryptographic binding to the WU's future child session. A failed canary means do **not** reserve or launch any new worker.

## 3. Do not bypass the durable controller

A reconciled dispatch ID (e.g. `e0504-repair-1`) cannot be reused. A verified provider repair is a prerequisite **but not automatically authority** to clear the blocker or start a new dispatch.

- Re-read status/audit/verify in the same root session and compare exact blocker revision, role/model/backend, active WU, budget, dispatch settlement and candidate history.
- Legacy free-text auth errors require independently verifiable provider evidence and an authorized recovery procedure. The new read-only classifier alone does not issue a recovery receipt.
- Do not use `clear_blocker` based solely on a text resolution, even if the current API accepts it; do not edit `events.ndjson` or clear a true scope/authority/security blocker.
- Only once the recovery authority and proof-binding are implemented and verified may the controller clear the exact blocker. Reserve a **new distinct dispatch ID** for any later repair, under the same authorized WU and approved finite budget.
- Repair `TR-5`/`AC-7` using the exact local rejected candidate and approved policy; validate a new immutable candidate and require a fresh independent review and any mandated CI/merge gates.

If no governed recovery path is available, stop with `OWNER_ACTION_REQUIRED`. Do not declare `WU_COMPLETE`.

## Acceptance evidence

Record the loaded plugin fingerprint, current root checkout, old blocker revision + original dispatch handoff identity, live provider response, provider/model routing, exact recovery event, new worker dispatch ID, and candidate verification + fresh review PASS. Unit tests and GitHub CI cannot substitute for this real OpenCode canary.
