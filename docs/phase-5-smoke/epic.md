---
artifact_id: "epic-p5-smoke-v1"
artifact_type: "epic"
status: "APPROVED"
created_at: "2026-10-03T00:00:00.000Z"
source_refs: ["FINAL_RELEASE_REPORT.md", "docs/phase-5-v1-capability-matrix.md"]
parent_refs: []
---

# Harness v1 happy-path smoke: resolveBinary behavior test

Prove the supported Harness v1 happy path end-to-end on the frozen baseline with
**no fault injection and no Phase-4 repair/recovery**:

```text
owner-approved Epic → approve_mandate → activate_wu → real harness-builder
  → frozen candidate → deterministic verification → fresh independent
  harness-reviewer PASS → complete_wu
```

Start condition: plugin loaded at `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`;
`harness_check_agent_readiness` ready for builder and reviewer.

User-visible outcome: a focused test file
(`tests/harness-v1-smoke.test.js`) asserts already-supported `resolveBinary`
behavior — an executable on `PATH` resolves, a non-executable file is not
resolved, and a missing name is not resolved. No product behavior changes.

Terminal demo: the WU reaches `complete_wu` with a PASS review bound to real
verification receipts for the frozen candidate.

End condition: `complete_wu` for the one derived WU, or an honest STOP with the
failure recorded (a STOP is itself a release-blocking finding).

execution_mandate: {"max_wus": 1, "total_seconds": 900}
