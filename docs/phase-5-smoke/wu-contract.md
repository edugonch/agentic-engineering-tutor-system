# WU-P5-SMOKE-V1 — resolveBinary behavior test (smoke)

Status: READY FOR OWNER-APPROVED ACTIVATION
Epic: `epic-p5-smoke-v1`
Origin: DERIVED
Execution authorization: AUTHORIZED_BY_MANDATE
Authority source: `epic-p5-smoke-v1`
CHILD_WORK_UNITS_ALLOWED: NO

## Story and Epic connection

Validates the frozen v1 happy path without exercising Phase-4 repair/recovery.

## Single outcome

Add exactly one new test file, `tests/harness-v1-smoke.test.js`, that asserts the
already-implemented `resolveBinary` behavior. No production code changes.

## Acceptance criteria

The new test file must, using Node's built-in test runner and importing
`resolveBinary` from `./src/resolve-binary.js`:

- create a temporary directory containing an executable regular file and a
  non-executable regular file;
- assert that the executable file resolves when found by simple name on `PATH`;
- assert that the non-executable file is **not** resolved (returns `null`);
- assert that a missing name is **not** resolved (returns `null`);
- clean up the temporary directory.

## Boundaries

### Included

- Add `tests/harness-v1-smoke.test.js` only.

### Excluded

- Any change to `src/resolve-binary.js`, `index.js`, `package.json`, the
  verification contract, the Epic, or any other file.
- Absolute-path resolver behavior (Phase-4 experiment, not part of v1).
- Repair, recovery, blocker handling, or fault injection.

## Dependencies

- None. Builds on the frozen Phase 3 baseline.

## Approved execution budget

- Within the Epic envelope `max_wus=1`, `total_seconds=900`. Suggested build
  reservation: 300s.

## Stop condition

Stop when the candidate is frozen, all declared checks pass, and an independent
reviewer returns PASS; or immediately on any deviation (unexpected extra change,
failed check, readiness gap). Do not create another WU. Do not repair or recover.

## Handoff evidence (builder must report)

- Changed file(s) and SHA-256.
- The exact command run and result.
- Confirmation that no other file changed.

## Verification contract

`docs/phase-5-smoke/verification-contract.json` — checks `smoke-behavior` and
`smoke-test`. Freeze with
`base_paths = ["package.json", "src/resolve-binary.js"]` (package.json supplies
`"type": "module"` to the materialized workspace) and
`overlay_paths = ["tests/harness-v1-smoke.test.js"]`.
