# Phase 4 — final status (owner decision, immutable)

> This is the permanent record of the final owner decision that closes Phase 4.
> It does not modify any frozen Phase-4 artifact, candidate, contract or event log.
> It is part of the Harness v1 release package.

## Result

```text
PHASE_4 = FAIL
Reason:  RECOVERY_LIVENESS_GAP
```

The frozen Phase-4 contract requires a real
`A → B → independent PASS → WU_COMPLETE` trace. That trace never completed, and
the defect that prevented it is durable, not incidental. Phase 4 therefore cannot
honestly be marked PASS, and FAIL is not to be reinterpreted as PASS.

## Concrete evidence (real `-004` runtime)

Execution: `P4-RESOLVEBINARY-ABSOLUTE-004`
(`.harness/execution/controller/P4-RESOLVEBINARY-ABSOLUTE-004/events.ndjson`, 19
events, immutable).

The runtime proved, in order:

- exact loaded revision and owner-approved Epic/mandate/WU;
- a real Build A;
- Candidate A (`cand-811785cd021f88638207a60fa79015c0a778c12ae5f24d65ceb128178b5949fc`);
- a durable `BLOCK`, class `BLOCKED_TOOLING` (`tooling-missing-ready-txt`);
- one authorized recovery (`authorize_recovery` → `restore-ready`);
- the exact native `shell` action;
- a durable `recovery_action_claim` **before** the side effect (event 16);
- durable `recovery_action_evidence` with `status: PASS` (event 17);
- no double escaping.

Then the recovery dispatch `recovery-ready` was finished and reconciled
(events 18–19) **before** the required `tooling-ready` verification receipt was
produced.

## Why this is a liveness defect

After settlement, the durable controller correctly enforces each of the
following, and their combination strands the WU:

1. `harness_run_verification` rejects verification of `tooling-ready` because the
   WU no longer has a live `REVIEW`/`RECOVERY` dispatch — settled dispatches
   cannot produce a fresh bound receipt.
2. The recovery cannot be repeated: the WU-level single-use action claim/dispatch
   entitlement is consumed, so the same (or a new) recovery cannot run again.
3. The existing recovery session cannot be relaunched.
4. `resolve_blocker` correctly rejects resolution because the fresh
   tooling-ready evidence is missing.
5. A fresh execution under explicit owner authority was correctly rejected by
   durable ownership: WU / approved-Epic authority is already owned by the
   original `-004` controller.

Therefore a legitimate WU can become permanently stranded after successful
recovery action evidence but before the required recovery diagnostic evidence.
This is a real liveness gap in the recovery path.

## What this is not

The FAIL is **not**, and must not be recorded as:

- budget exhaustion;
- shell transport failure;
- double escaping;
- owner authority failure;
- candidate corruption;
- permission widening;
- a reason to weaken anti-replay ownership.

## What is retained as accepted (bootstrap)

The Phase-4 bootstrap implementation, repairs R1–R4, the combined amendment, the
Q1 controller authority-boundary correction and the Harness-tool transport
normalization were each independently reviewed (see
`docs/phase-4-bootstrap-report.md`,
`docs/phase-4-bootstrap-review-evidence.md`,
`docs/phase-4-combined-amendment-review-evidence.md`). They remain **bootstrap
evidence only**. Their green automated suites are not runtime acceptance, and
none of them promotes Phase 4 to PASS.

## Preserved history (do not clean)

Immutable evidence retained in place:

- `P4-RESOLVEBINARY-ABSOLUTE-002` and proposal packet v4 (`e3928a36`);
- `P4-RESOLVEBINARY-ABSOLUTE-003` (stopped: `ACTOR_INPUT_MISMATCH` /
  double escaping; no `action_claim`, no side effect);
- `P4-RESOLVEBINARY-ABSOLUTE-004` (the liveness-gap execution above);
- the failed R2 initialization: `.harness/execution/controller/P4-RESOLVEBINARY-ABSOLUTE-004-R2/`
  containing only `lease.json`. This partial directory is deliberate disclosed
  evidence and must remain; it is not to be cleaned as part of closure.
- Untracked proposal Epics under `.harness/epics/EPIC-P4-*` and
  `docs/proposals/phase-4-runtime*`, plus the working-tree experiment residue
  (`src/resolve-binary.js` builder-A overlay with the deliberate directory
  defect, `tests/resolvebinary-executable.test.js`, and the uncommitted
  knowledge-index approvals) are preserved on branch `phase-4-bounded-repair`.

Execution state under `.harness/execution/` is intentionally git-ignored runtime
evidence; preservation is filesystem-level.

## Known debt (preserve exactly; do not solve now)

A recovery dispatch may be settled after action evidence but before its required
success-check receipt, leaving the WU unable to resolve the blocker while durable
ownership correctly prevents a fresh authority reset. This is the Phase-4
liveness defect. It is retained for future work and is out of scope for Harness
v1.

## Harness v1 consequence

Harness v1 does not depend on Phase-4 autonomous bounded repair/recovery. No
`repair_policy` is issued for normal v1 production workflows. If a real
operational WU receives `CHANGES_REQUIRED` or requires blocker recovery, control
returns to the owner. Phase-4 repair/recovery remains
**EXPERIMENTAL / NOT RELEASED / KNOWN LIVENESS DEFECT**.
