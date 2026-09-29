---
name: work-unit-authoring
description: Define, split, or validate a bounded Work Unit; use when turning an Epic outcome into executable work, checking whether a unit is atomic, adding acceptance criteria, or deciding how to handle discovered blockers and follow-up work.
compatibility: opencode
metadata:
  harness: bounded-execution
---

# Work Unit Authoring

Write WUs as independent, verifiable story beats within an Epic. Independence means a WU owns one coherent outcome with its own acceptance evidence; it does not mean WUs are unrelated. Use explicit sequence and dependencies to show how accepted outcomes compose into the chapter.

## Required contract

- Epic link and position in its story
- One coherent, indivisible outcome
- Observable acceptance criteria and required evidence
- Included and excluded scope
- Explicit dependencies or `none`
- Owner-approved active-time or call budget appropriate to the project
- `CHILD_WORK_UNITS_ALLOWED: NO`
- Stop condition and handoff report format

## Atomicity test

Ask whether the unit can be accepted on its own and whether it describes one user/developer-visible outcome. If it contains multiple independently acceptable outcomes, revise the Epic sequence before activation. Do not split work into implementation chores that require nested WUs. Chores may be steps inside one WU if they serve its single outcome.

## Blockers and repair

When a blocker, failed test, review finding, or missing prerequisite appears:

1. Record evidence and identify whether it falls inside the activated WU's boundaries.
2. If a correction is clearly inside scope and the approved budget remains, allow the builder to address it within the same WU.
3. Otherwise stop and return the exact owner decision needed.
4. Never auto-create a child, repair, coordination, research-follow-up, or successor WU.

On budget exhaustion, return `WU_BUDGET_EXHAUSTED` with completed evidence and remaining acceptance criteria. No automatic continuation.
