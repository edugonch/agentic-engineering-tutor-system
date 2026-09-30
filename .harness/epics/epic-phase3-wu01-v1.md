---
artifact_id: "epic-phase3-wu01-v1"
artifact_type: "epic"
status: "APPROVED"
created_at: "2026-09-30T21:47:56.635Z"
source_refs: ["docs/phase-3-autonomous-wu-controller.md"]
parent_refs: []
---

# First governed WU: resolveBinary executable-bit

Demonstrate, for the first time, one real Work Unit moving from a mandate-derived
authorization through independent verification to durable closure with no human
intervention in between, using the Phase 2 durable controller and the Phase 3A
governed surface.

Start condition: PHASE_0/1/2/3A = PASS.

User-visible outcome: resolveBinary reports a program on PATH as usable only when
it is a regular file with at least one executable bit set.

Terminal demo: a readiness gate no longer returns READY for a non-executable file
on PATH; an executable file still resolves.

End condition: WU-01 reaches complete_wu with a PASS review bound to real
verification receipts.

execution_mandate: {"max_wus": 1, "total_seconds": 900}