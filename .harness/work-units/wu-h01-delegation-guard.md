# H-WU-01 — Delegation guard stops killing valid WUs

Status: IN_PROGRESS
Epic: EPIC-EXECUTION-CONTROL-PLANE-REPAIR-001
CHILD_WORK_UNITS_ALLOWED: NO
Owner activation: APPROVED (owner direction 2026-10-06)

## Story and Epic connection

The fixed per-turn delegation ceiling caused the WU-058 false stop. Making it an
explicit operator-only fuse (off by default) and emitting machine-readable error
codes is the first, independent repair of the control plane.

## Single outcome

`HARNESS_MAX_DELEGATIONS` is disabled by default (a null ceiling, enforced only
when the operator sets it explicitly), and every guard trip carries a stable
machine-readable error code.

## Acceptance criteria

- `readGuardSettings({})` returns `maxDelegations: null`.
- Default guard allows > 16 delegations without throwing.
- Explicit `HARNESS_MAX_DELEGATIONS=3` blocks the 4th delegation with
  `code === "HARNESS_DELEGATION_LIMIT_EXCEEDED"`.
- Tool-call and repeated-mutation trips carry
  `HARNESS_TOOL_CALL_LIMIT_EXCEEDED` / `HARNESS_REPEATED_MUTATION`.
- The anti-loop reset property (external prompt resets, internal continuation
  does not) is preserved.

## Boundaries

### Included
- `src/turn-guard.js`, `tests/turn-guard.test.js`, `README.md` env table row.

### Excluded
- Durable budget/reservation changes; controller dispatch changes; merge; ALFRAN.

## Dependencies
- none

## Approved execution budget
- Active-time limit: within Epic mandate
- Remaining Epic WU budget after this unit: 7

## Stop condition
Stop when acceptance passes, budget exhausted, or a blocking decision is needed.

## Handoff evidence
- Changed files: src/turn-guard.js, tests/turn-guard.test.js, README.md
- Verification: tests/turn-guard.test.js 11/11 PASS; full suite 351/369 (18 pre-existing WIP controller-transfer failures, out of scope)
- Anti-loop reset property: preserved (index.js prompt hook untouched; continuation-driver.test.js isInternalPrompt + turn-guard reset test)
- Reviewer outcome: no code findings. Independent reviewer inspected the changeset and reported zero correctness/safety/scope issues; its sandbox lacked a test runner, so test execution was performed by the orchestrator (evidence above).
