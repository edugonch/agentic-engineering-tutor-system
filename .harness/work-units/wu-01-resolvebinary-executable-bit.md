# WU-01 — `resolveBinary` verifies the executable bit

Status: DRAFT / NOT AUTHORIZED
Epic: `epic-phase3-wu01-v1`
CHILD_WORK_UNITS_ALLOWED: NO
Owner activation: PENDING

## Story and Epic connection

Moves E01 toward its terminal demo: the first real WU governed end-to-end under
a mandate-derived authorization. It is the smallest real, verifiable piece of
Harness code, already recorded as Phase 1 debt.

## Single outcome

`resolveBinary(program)` returns a `PATH` candidate only when that candidate is a
regular file with at least one executable bit set. A file that exists but is not
executable is no longer treated as a usable binary.

## Acceptance criteria

- A non-executable file on `PATH` is NOT resolved (skipped / returns null).
- An executable file on `PATH` IS resolved.
- Unit test coverage exercises both cases.

## Boundaries

### Included

- Change `resolveBinary` in `index.js` to check the executable bit (any `0o111`
  bit) in addition to existence.
- Add or extend a test that proves both the executable and non-executable cases.

### Excluded

- Reviewer identity attestation.
- PATH / browser / process containment hardening.
- Broader binary-detection changes beyond `resolveBinary`.

## Dependencies

- None. Builds on the Phase 3A governed surface.

## Approved execution budget

- Active-time limit: OWNER-APPROVED (within the Epic envelope).
- Remaining Epic WU budget after this unit: 0.

## Stop condition

Stop when the acceptance criteria pass, the approved budget is exhausted, a
blocking decision is needed, or scope would have to change. Report status and
evidence. Do not continue by creating another WU.

## Handoff evidence

- Changed files / artifact references: PENDING
- Verification performed and result: PENDING
- Known limitations or unresolved decisions: PENDING
- Reviewer outcome: PENDING
