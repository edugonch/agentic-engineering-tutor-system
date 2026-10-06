---
artifact_id: "EPIC-EXECUTION-CONTROL-PLANE-REPAIR-001"
artifact_type: "epic"
status: "APPROVED"
created_at: "2026-10-06T18:00:47.812Z"
source_refs: ["https://github.com/edugonch/agentic-engineering-tutor-system"]
parent_refs: []
---

# Repair the Harness execution control plane

# EPIC-EXECUTION-CONTROL-PLANE-REPAIR-001 — Repair the Harness execution control plane

Status: APPROVED
Project story link: .harness/PROJECT_STORY.md
Product Owner approval: APPROVED (owner direction 2026-10-06)

## Chapter purpose

The Harness's own execution control plane produced a false stop in a governed
Work Unit (the WU-058 incident): a fixed per-turn delegation ceiling killed a
legitimate build → review → repair → review flow, and pre-launch dispatch
failures leaked reservations. This chapter repairs those defects and, where the
owner chose governed_auto merge, extends the control plane so a verified WU can
integrate without a human handoff. ALFRAN is the incident scenario, not a target
of this repair; it is not modified.

## Start condition

Baseline committed on fix/fresh-session-controller-transfer-20261004 at
5c06408f. Suite green except the pre-existing WIP controller-transfer.test.js
(18 failing tests, tracked as separate debt).

## User-visible outcome

A normal governed WU no longer hits a false per-turn delegation stop; pre-launch
dispatch failures recover without leaked reservations; block/checkpoint have a
typed contract; and governed_auto projects can integrate a reviewed,
exact-head-CI'd candidate via a dedicated merge executor with idempotent recovery.

## Terminal demo and acceptance

End-to-end regression reproduces the WU-058 incident and completes WU_COMPLETE
autonomously, while every hard stop still halts execution. Acceptance evidence:
tests/execution/e2e-wu058-regression.test.js and
tests/execution/hard-stop-regression.test.js PASS, plus per-WU unit suites.

## Approved WU budget

Maximum WU count: 8. Budget approval status: APPROVED. If exhausted before the
terminal condition, stop with EPIC_REBASE_REQUIRED.

## Work Unit sequence

1 H-WU-01 delegation guard stops killing valid WUs (default off + codes)
2 H-WU-02 deterministic dispatch recovery + pre-launch release
3 H-WU-03 block/checkpoint typed contract
4 H-WU-05 PR binding + exact-head CI evidence
5 H-WU-06 governed merge executor + merge_policy + idempotent recovery
6 H-WU-07 WU_COMPLETE conditioned on merge_verified
7 H-WU-04 orchestrator prompt consolidation
8 H-WU-08 E2E WU-058 regression + hard-stop suite

## Out of scope

ALFRAN is not modified. Production deploy/migration, secrets, live DB actions.
The WIP controller-transfer.test.js defect (separate debt).

## Dependencies

GitHub merge adapter direction approved by owner (documented ADR before H-WU-06).

execution_mandate: {"max_wus":8,"total_seconds":28800}