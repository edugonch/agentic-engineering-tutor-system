# Work Units

A WU is one coherent, independently verifiable and indivisible outcome inside an Epic. It can be related to earlier or later WUs through explicit dependencies or story continuity; that relationship does not split the outcome into child units.

Each WU needs a single outcome, acceptance criteria, in-scope/out-of-scope boundaries, explicit dependencies, an owner-approved execution budget, and a stop condition. Declare `CHILD_WORK_UNITS_ALLOWED: NO`. On a blocker, failed check, review finding, or budget exhaustion, report the evidence and stop. Do not create repair, successor, coordination, or child WUs without owner approval.

Use `../templates/WORK_UNIT.md` as the contract skeleton.
