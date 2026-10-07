# Work Units

A WU is one coherent, independently verifiable and indivisible outcome inside an Epic. It is also one self-contained story beat in the Epic's **predeclared finite sequence**.

Every WU for an Epic is created before the first WU is activated. Each contract identifies its sequence position, predecessor and already-declared successor (or Epic close). This gives continuity without allowing a WU or runtime agent to manufacture follow-up scope.

Each WU needs a single outcome, acceptance criteria, in-scope/out-of-scope boundaries, explicit dependencies, an owner-approved execution budget, and a stop condition. Declare `CHILD_WORK_UNITS_ALLOWED: NO`.

On a blocker, failed check, review finding, budget exhaustion, or discovery that the planned sequence is insufficient, report the evidence and stop. Do not create repair, successor, coordination, or child WUs automatically. If the Epic cannot reach its terminal condition using the approved sequence, the correct state is `EPIC_REBASE_REQUIRED`.

Use `../templates/WORK_UNIT.md` as the contract skeleton.
