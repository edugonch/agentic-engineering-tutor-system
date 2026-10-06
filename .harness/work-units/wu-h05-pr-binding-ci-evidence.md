# H-WU-05 — PR binding + exact-head CI evidence

Status: IN_PROGRESS
Epic: EPIC-EXECUTION-CONTROL-PLANE-REPAIR-001
CHILD_WORK_UNITS_ALLOWED: NO
Owner activation: APPROVED (owner direction 2026-10-06)

## Story and Epic connection

Governed merge requires the controller to know exactly what is being integrated:
the PR, the exact reviewed head SHA, and CI evidence bound to that exact head
and candidate. This WU adds the two binding operations that make CI a durable,
verifiable fact rather than a prose claim.

## Single outcome

The controller can durably record a PR binding (`BIND_PR`) and exact-head CI
evidence (`RECORD_CI`), rejecting CI from another SHA or candidate.

## Acceptance criteria

- `BIND_PR` persists repository, PR number, candidate, head SHA, base branch; rejects an unknown candidate or a candidate not belonging to the active WU.
- `RECORD_CI` persists candidate, head SHA, check identity, conclusion; rejects a stale head SHA (not matching the bound PR), an unknown candidate, and a conclusion outside the `CI_CONCLUSIONS` vocabulary.
- `conclusion` is typed (`SUCCESS`/`FAILURE`/`PENDING`/`ERROR`); only `SUCCESS` gates a merge (enforced in H-WU-07).

## Boundaries

### Included
- `src/execution/constants.js` (BIND_PR, RECORD_CI op types; CI_CONCLUSIONS)
- `src/execution/state.js` (handlers + validation)
- `src/execution/controller-tool.js` (bind_pr, record_ci actions; summary fields)
- `src/execution/index.js` (CI_CONCLUSIONS export)
- `index.js` (schema: actions + fields)
- `tests/execution/controller-tool.test.js`

### Excluded
- Merge executor + policy (H-WU-06). WU_COMPLETE gate (H-WU-07). ALFRAN.

## Dependencies
- none

## Approved execution budget
- Active-time limit: within Epic mandate
- Remaining Epic WU budget after this unit: 4

## Stop condition
Stop when acceptance passes, budget exhausted, or a blocking decision is needed.

## Handoff evidence
- Changed files: constants.js, state.js, controller-tool.js, execution/index.js, index.js, controller-tool.test.js
- Verification: controller-tool.test.js 29/29 PASS; full suite 358/369 (18 pre-existing WIP)
- Reviewer outcome: BLOCKED — the deployed (old) plugin's delegation ceiling fired at the 4th subagent dispatch ("exceeded 3 subagent delegations"). This is the WU-058 defect manifesting live; independent review deferred until the fixed plugin is deployed.
