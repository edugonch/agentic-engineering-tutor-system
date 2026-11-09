# TDD RED-first runtime preflight

The Harness prevents a late TDD-order defect **before** a builder can modify production files. It does not create additional Work Units, rewrite old events, or waive frozen acceptance.

## Normal flow for an active, typed TDD WU

The authoritative Work Unit contract must include `{"kind":"tdd","required":true}` in `process_obligations`. The controller's `operational_status.tdd_gate` and the builder's durable session context report:

- `RED_FIRST`: only project reads and focused test-file creation/editing (or a verification-contract-declared test script) are allowed. The V2 `execute.before` hook denies production edits, shell, apply_patch and other opaque tools.
- `RED_RECORDED`: after a real FAIL receipt is recorded under `record_red`, normal in-scope production implementation may proceed.
- `RETROSPECTIVE_RECOVERY`: an existing, explicitly adopted scoped process recovery controls the deviation. Original historical RED is not claimed.
- `NOT_REQUIRED`: no typed TDD requirement applies; normal work is unchanged.

The orchestrator takes the test-only handoff in the **same existing WU**, reconciles its dispatch, freezes a test-only candidate, runs a declared check via `harness_run_verification` and records the immutable failing receipt with `harness_execution_controller(action="record_red", evidence_id=...)`. The subsequent same-WU builder implements and returns GREEN evidence. The independent reviewer and existing merge gates remain in force. No separate owner approval is requested merely to follow the WU's already-approved TDD sequence.

A missing module/import error cannot be used as `record_red` or retrospective `record_process_evidence`: that alone is not a product-behavior assertion. Prefer a focused failing behavior test against existing contract/API surfaces. If no meaningful failing test is runnable without first implementing production code, report that **technical constraint** instead of deleting files to force an error.

## Limitations and continuity

This runtime enforcement applies to structured TDD obligations on active `harness-builder` dispatches. Legacy prose still requires human review/normalization and must not be treated as an implicit waiver. Existing work that preceded RED is **not grandfathered as historically compliant**: preserve its implementation and use an owner-authorized retrospective recovery only when the exact policy applies. In particular, this patch does not mutate or unblock ALFRAN WU066 or reinterpret immutable Phase-4 history.

The hook covers OpenCode V2 tools invoked by the loaded Harness builder. It is not a general filesystem sandbox against unrelated OS processes, plugins, or deliberately misclassified test paths. The test-path allowlist is based on common test directories, `*.test.*`/`*.spec.*` filenames and scripts declared in the frozen verification contract; protected directories and symlink escapes are rejected. It does not claim perfect source provenance or autonomous quality verification.

When the builder is blocked with `TDD_RED_FIRST`, do not reset the execution or create a replacement WU. Return to the test-only stage using the same approved contract. If RED is impossible because the declared verification contract cannot assert a product invariant, report the exact contract issue for the existing governed correction path.

## Validation

```sh
npm run check
node --test tests/execution/tdd-preflight.test.js tests/plugin-wiring.test.js
```

Native OpenCode V2 execution remains a separate requirement to demonstrate that the host actually delivers the expected `edit`, `write`, `shell` and `subagent` events at the runtime boundary.
