# ALFRAN EPIC-05 — governed E05-04 recovery canary

**Status:** Instructions for execution in the owner's connected **local OpenCode runtime**. Not an assertion that a GitHub PR or CI run has accessed that runtime. Executing this canary never authorizes a new product policy, a reset, a new WU, or a bypass of verification/review/merge gates.

## Preflight — no mutation

1. Confirm the **loaded** plugin fingerprint from `harness_check_agent_readiness`; compare against the published intended revision. A matching GitHub `main` alone proves nothing about an OpenCode process.
2. Call `harness_execution_controller(action="audit_recovery", execution_id="alfran-epic05-delivery")`.
3. Record the audit's `revision`, `active_wu_id`, `blocker_event.operation_id`, `blocker_event.previous_revision`, `blocker_event.body_hash`, `scope_diagnosis`, all completed predecessor candidates and merge SHAs, unsettled dispatches and budget (sanitizing private paths and credentials).
4. Call `status` and `verify`. Verify that `blocker.at_revision` equals the event's **previous_revision**, not `next_revision`; the historical event is never edited. The currently expected blocked WU is E05-04-E.
5. Verify the current session root worktree has the expected Git common-dir with the canonical project and HEAD at the previously verified E05-03 merge. Do not mutate Git, `events.ndjson`, prior candidates, or WU artifacts.

## Scope reconciliation — only with positive evidence

Call `harness_execution_controller(action="inspect_scope_worktree", execution_id="alfran-epic05-delivery")` from the authenticated root orchestrator in the recovery worktree. If and only if it reports `VERIFIED_RECONCILABLE` and source hashes match, call `reconcile_stale_worktree_scope` using **exactly** `expected_revision` from the fresh status and `blocked_at_revision` from the existing blocker.

If the result is `EVIDENCE_REQUIRED`, `NOT_ELIGIBLE` or `NOT_VERIFIED`, preserve the blocker, return the exact missing evidence and stop. Do not invent a positive scope decision. After a successful reconcile, call `verify` and `status` again; confirm original WU scope, budget, predecessor history and active E05-04 identity are unchanged.

## Continuity and acceptance

Resume the **existing** E05-04-E output from the moved worktree; do not repeat already accepted work or freeze predecessor files as part of E05-04. The registered `harness_freeze_candidate` must capture E05-04 output bytes from the authenticated *current session* worktree while retaining candidate registry and controller under canonical project storage.

Run all declared verification checks from the exact frozen candidate, including their setup; differentiate the candidate-clean check from a dirty local workspace without waiving a mandatory check. Fresh reviewer must independently review exact candidate/verification evidence. Merge and WU_COMPLETE only after the gate conditions pass; then automatically activate next frozen E05-05-E, verify durable identity and perform its first safe bounded authorized work.

## End-to-end acceptance record

Record: loaded plugin fingerprint, initial and final controller revisions, blocker evidence hash and reconciliation receipt (or the precise fail-closed status), E05-04 candidate identity, verification receipt IDs and results, independent reviewer verdict, exact PR HEAD/CI/merge receipt and E05-04 WU_COMPLETE, next-WU activation receipt for E05-05. A partial outcome or a pending real-provider step remains **NOT VALIDATED**, even when CI passed for the Harness package.

*The GitHub connector cannot read the live user's local OpenCode journal and should never pretend to do so.*
