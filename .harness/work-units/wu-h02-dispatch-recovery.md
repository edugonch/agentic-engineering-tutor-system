# H-WU-02 — Deterministic dispatch recovery + pre-launch release

Status: IN_PROGRESS
Epic: EPIC-EXECUTION-CONTROL-PLANE-REPAIR-001
CHILD_WORK_UNITS_ALLOWED: NO
Owner activation: APPROVED (owner direction 2026-10-06)

## Story and Epic connection

The WU-058 incident left a prepared reviewer dispatch in `PENDING_LAUNCH` after the
subagent launch was rejected before an external session existed. Recovery must
distinguish "deterministically never launched" (releasable) from "launch may have
had a side effect" (must stay ambiguous). This WU makes that distinction structural.

## Single outcome

A claimed launch (`launch_call_id` set) can never be released by the state machine;
release is only valid when there is deterministic evidence the launch never
happened. The recovery classification (`recover`) already routes
`PENDING_LAUNCH` + `launch_call_id` → `AMBIGUOUS`; release now enforces the same
boundary structurally rather than only through the repair-policy path.

## Acceptance criteria

- `DISPATCH_RELEASE` on a `PENDING_LAUNCH` dispatch with `launch_call_id` set throws
  (`Cannot release ... launch was claimed ... mark it ambiguous`).
- `DISPATCH_MARK_AMBIGUOUS` remains the correct path and preserves the reservation.
- Existing matrix unchanged: `PENDING_LAUNCH` without `launch_call_id` is
  `NEVER_LAUNCHED` (releasable); `LAUNCHED` never releasable; `AMBIGUOUS` never
  auto-released; release is idempotent and never double-credits.

## Boundaries

### Included
- `src/execution/state.js` (DISPATCH_RELEASE structural guard)
- `tests/execution/dispatch-reservation.test.js` (new claimed-launch case)

### Excluded
- Generalizing the launch-claim/actor machinery beyond the repair-policy path (a
  separate hardening concern). Orchestrator prompt rules (H-WU-04). Merge.

## Dependencies
- none

## Approved execution budget
- Active-time limit: within Epic mandate
- Remaining Epic WU budget after this unit: 6

## Stop condition
Stop when acceptance passes, budget exhausted, or a blocking decision is needed.

## Handoff evidence
- Changed files: src/execution/state.js, tests/execution/dispatch-reservation.test.js
- Verification: dispatch-reservation + recovery + phase4 test files 62/62 PASS; full suite 352/369 (18 pre-existing WIP)
- Reviewer outcome: PASS (independent review confirmed guard placement, budget preservation, and consistency with recover() classification)
