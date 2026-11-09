# WU and Epic duration: planning estimates only

**Owner clarification (2026-11-09):** A Work Unit's suggested maximum duration exists solely to make planned work small enough to divide and review. Epic totals, WU `active_seconds`, dispatch `reserved_seconds` and any historical time_policy are **not execution ceilings**. Nothing stops automatically when those numbers expire.

## Runtime behavior

- The approved Epic and ordered, finite WU sequence still govern scope. No additional WU, Epic rebase, or owner authorization is requested because work takes longer than estimated.
- The controller does not reject reserve, launch, verification or merge because of elapsed/remaining estimated seconds. The supervisor does not stop continuing on a time estimate. The worker session has no budget-expiry interrupt timer.
- A verification command retains its **own frozen safety timeout** and still requires an authorized frozen candidate/check; no model-supplied free-form command is accepted.
- The ledger retains observed elapsed time, consumed/reserved estimates and overrun. Public `budget.enforced=false` and `budget.estimate_exceeded` distinguish reports from authorization.
- Existing `BUDGET_EXHAUSTED` events remain part of immutable history. After all side effects (dispatches, phase, verification, external wait) are settled, `clear_blocker` may retire an exact legacy time-only stop with a new audited CLEAR_BLOCKER event. The supervisor performs this retirement for its authenticated root when safe. Do not blindly reset an active or ambiguous child.
- New BUDGET_EXHAUSTED block attempts are refused. Security, permission, actual scope, missing model funds, stale candidate/verification, orphan identity and functional defects remain genuine blockers.
- WU JIT normalization derives a stable per-WU **planning** estimate from the original Epic estimate and frozen WU count. It does not divide negative remaining time or require a legacy time-policy adoption.
- Historical owner-approved time/amendment records are preserved but are not prerequisites for normal execution.

## Existing ALFRAN continuation

For `alfran-epic03-continuation`, no new Epic, new execution, or `+250000 s` transition is needed to continue WU069–WU072. Preserve the approved WU order and PR #174. Read the current controller status, settle any ambiguous/unfinished dispatch, retire only a *time-only* blocker if present, and continue under the same execution. The previously recorded budget-extension Epic is archive evidence, not a new scope mandate.

A `provider.quota: Insufficient account funds` result remains an external provider problem. This change does **not** claim that the model provider is funded, and it does not fabricate completion or bypass actual account limits.

## Tests and rollout

```sh
npm run check
npm run test:recovery:mutations
npm run test:sources:mutations
```

Audit the effective OpenCode plugin revision after update/restart. Keep historical event logs, acceptance receipts and the failed Phase-4 record unchanged. No file-system/shell process isolation claim follows merely from passing mock-host tests.
