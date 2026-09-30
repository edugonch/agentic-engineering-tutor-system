# WU-01 — `resolveBinary` verifies the executable bit

Status: COMPLETED
Epic: `epic-phase3-wu01-v1`
Origin: DERIVED
Execution authorization: AUTHORIZED_BY_MANDATE
Authority source: `epic-phase3-wu01-v1`
CHILD_WORK_UNITS_ALLOWED: NO

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

- Change `resolveBinary` to check the executable bit (any `0o111` bit) in
  addition to existence.
- Add a test that proves both the executable and non-executable cases.

### Excluded

- Reviewer identity attestation.
- PATH / browser / process containment hardening.
- Broader binary-detection changes beyond `resolveBinary`.

## Dependencies

- None. Builds on the Phase 3A governed surface.

## Approved execution budget

- Active-time limit: OWNER-APPROVED (within the Epic envelope `max_wus=1`, `total_seconds=900`).
- Remaining Epic WU budget after this unit: 0.

## Stop condition

Stop when the acceptance criteria pass, the approved budget is exhausted, a
blocking decision is needed, or scope would have to change. Report status and
evidence. Do not continue by creating another WU.

## Handoff evidence

- Changed files / artifact references: `index.js` (modified), `src/resolve-binary.js` (new), `tests/resolvebinary-executable.test.js` (new). Commit `f28bc426327315ba19d79a4ced50b5cd5e4c38e7`. Candidate `cand-1ae9865d91d3dc232714bb2130695dbcc8745d4234df2f31796f3ef9c1c0bae4`.
- Verification performed and result: receipt `verify-cd3e4ed8df44dfaae63db014660e7c01a696cb52ef8538641cec1f675d0fe8e8` (PASS).
- Known limitations or unresolved decisions: reviewer identity attestation deferred; Windows `;` PATH separator out of scope.
- Reviewer outcome: PASS (`harness-reviewer`, independent).
- Budget: used 300 / reserved 0 / remaining 600.
