# H-WU-03 — block/checkpoint typed contract

Status: IN_PROGRESS
Epic: EPIC-EXECUTION-CONTROL-PLANE-REPAIR-001
CHILD_WORK_UNITS_ALLOWED: NO
Owner activation: APPROVED (owner direction 2026-10-06)

## Story and Epic connection

The `block` action accepted a free-form `class` string and an optional `reason`,
so a reviewer-outcome name like `REVIEW_ENVIRONMENT_BLOCKED` could reach the
state machine. Typing `class` as the `BLOCKER_CLASSES` enum and requiring a
human-readable `reason` makes the contract machine-checkable at the boundary.

## Single outcome

`block` requires a typed `class` (a `BLOCKER_CLASSES` value) and a non-empty
`reason`; `note` remains checkpoint-only. Invalid classes are rejected before
they reach the state machine.

## Acceptance criteria

- `class` in the controller schema is an enum of `BLOCKER_CLASSES`.
- `reason` in the controller schema has `minLength: 1`.
- `block` action: valid `class` + `reason` → persisted; missing `class` →
  rejected; missing `reason` → rejected; unknown `class` (e.g.
  `REVIEW_ENVIRONMENT_BLOCKED`) → rejected.
- `checkpoint` `note` continues to work.

## Boundaries

### Included
- `index.js` (schema: class enum, reason minLength, note description)
- `src/execution/controller-tool.js` (block requires reason)
- `tests/execution/controller-tool.test.js` (block contract tests)
- `tests/execution/phase4.test.js` (call helper injects a default block reason)

### Excluded
- Reviewer-outcome → blocker mapping (H-WU-04). Merge. ALFRAN.

## Dependencies
- none

## Approved execution budget
- Active-time limit: within Epic mandate
- Remaining Epic WU budget after this unit: 5

## Stop condition
Stop when acceptance passes, budget exhausted, or a blocking decision is needed.

## Handoff evidence
- Changed files: index.js, src/execution/controller-tool.js, tests/execution/controller-tool.test.js, tests/execution/phase4.test.js
- Verification: controller-tool + phase4 test files PASS; full suite 354/369 (18 pre-existing WIP)
- Reviewer outcome: PASS (no in-scope findings; consolidated the duplicate `reason` schema key flagged as a maintainability hazard)
