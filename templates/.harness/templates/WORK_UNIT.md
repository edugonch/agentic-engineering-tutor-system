# WU-[ID] — [Outcome title]

Status: DRAFT / NOT AUTHORIZED  
Epic: [E##]  
CHILD_WORK_UNITS_ALLOWED: NO  
Owner activation: [PENDING]

## Story and Epic connection

- Sequence position: [N of TOTAL]
- Predecessor: [WU ID, PREVIOUS EPIC BOUNDARY, or NONE]
- Successor: [WU ID, EPIC CLOSE, or NONE]

Explain how this self-contained outcome continues the Epic story from its predecessor and hands a stable state to its already-declared successor without splitting this WU.

## Single outcome

State the one coherent result that will exist when this WU is accepted. The WU must be indivisible at the outcome level.

## Acceptance criteria

- [Observable criterion]
- [Evidence/test required]

## Boundaries

### Included

- [Only work required for the stated outcome]

### Excluded

- [Follow-up, cleanup, adjacent feature, or speculative work]

## Dependencies

- [None or exact blocking predecessor/decision]
- A blocker discovered during execution is reported; it does not authorize child, repair, coordination, or successor WUs. Only WUs already present in the approved Epic sequence may follow this one.

## Approved execution budget

- Active-time limit: [OWNER-APPROVED]
- Approval reference: [DECISION / DATE]
- Remaining Epic WU budget after this unit: [COUNT]

## Stop condition

Stop when acceptance criteria pass, the approved budget is exhausted, a blocking decision is needed, or scope would have to change. Report status and evidence. Do not continue by creating another WU.

## Handoff evidence

- Changed files / artifact references: [PENDING]
- Verification performed and result: [PENDING]
- Known limitations or unresolved decisions: [PENDING]
- Reviewer outcome: [PENDING]

## Executable contract (normalize before reservation)

Add one `execution_contract: { ... }` JSON line with the approved `active_seconds`,
`verification_contract` (`commands`, optional ordered `setup`, per-command
`timeout_ms`, capabilities/environment), and `process_obligations`. Preserve the
approved source and acceptance criteria; do not invent budget or approvals.
Normalize a historical WU through `bind_wu_contract` before the next candidate.
