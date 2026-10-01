# Proposed Epic — Phase 4 bounded runtime repair examination

**PROPOSED — OWNER REVIEW REQUIRED — NO EXECUTION AUTHORITY**

This document is a finite Epic proposal. Its machine-readable envelope is a
proposal, not a synthesized live mandate. Nothing here approves an artifact,
activates a WU, launches a specialist or starts runtime proof. Approval must be a
separate explicit owner decision; only then may the exact approved artifact be
registered and used to derive authority. Any change to the proposed contract or
its hashes requires presenting the changed version to the owner.

## Starting condition and one outcome

The owner accepted the Phase 4 bootstrap candidate
`cand-e02d28468349da2fe8f830e3a35869add05b491ab744463bc3cb2a0991412bcf`
with 265/265 tests, 24/24 Phase 4 tests, 73 validation paths and independent
DESIGN_SOUND / R1–R4 PASS. Its reviewed implementation has been committed.
Runtime proof is still pending. This chapter demonstrates one real outcome:
**resolveBinary supports absolute executable paths**, corrected A → B inside
one WU and budget, with fresh independent evidence and bounded tooling recovery.

## Proposed authority identities

| Field | Exact proposal |
|---|---|
| Epic | `EPIC-P4-RESOLVEBINARY-ABSOLUTE-001` |
| Sole derived WU | `WU-P4-RESOLVEBINARY-ABSOLUTE-001` |
| Future execution ID | `P4-RESOLVEBINARY-ABSOLUTE-001` |
| Future mandate ID | `P4-RESOLVEBINARY-ABSOLUTE-001-MANDATE-001` |
| Mandate revision | Content-addressed revision of this exact Epic artifact when explicitly owner-approved; no fabricated revision now |
| WU contract | `docs/proposals/phase-4-runtime/wu-contract.md` |
| WU contract SHA-256 | `5808858faa80dc8fdc19cfd87306661ddc8e413f790d3d53c34f3623df70aec7` |
| Verification contract | `docs/proposals/phase-4-runtime/verification-contract.json` |
| Immutable normative verification hash | `f1d7ae2de6f5ca2ada64f1d62dedb9dddc32c27656fb839aedd350743f1e9753` |
| Implementation/required loaded revision | `d385a84c5cae0e4fdd342ca856b7c434344c486d` |
| Changed paths | `src/resolve-binary.js`, `tests/resolvebinary-executable.test.js` only |
| Policy | version 1, `max_wus = 1`, `max_repair_cycles = 1`, cumulative 1800 seconds |

The named WU contract is part of this proposal and defines complete acceptance:
absolute executable with empty/unrelated PATH; missing path null; directory null;
non-executable file null; simple-name PATH search and executable-bit semantics
preserved. Approval binds that exact document and the complete frozen verification
commands, not a shortened summary or a substitute task. Approved artifact metadata
would carry owner authority without editing these proposed contract bytes.

## Explicit proposed injection authority

Upon owner approval, this Epic explicitly authorizes the two bounded injections
described in its WU contract:

1. Builder A may deliberately leave the absolute-directory case unresolved while
   retaining all acceptance assertions. The independent reviewer runs **all**
   frozen checks and decides the verdict. No instruction to fabricate
   CHANGES_REQUIRED, suppress a result or reclassify BLOCKED/PASS is authorized.
2. Within Build A's reservation, create the named private tooling fixture parent
   with `ready.txt` absent. After recording A, use that actual observed absence
   for BLOCKED_TOOLING and one exact approved restoration, before reviewer A.

Only actual CHANGES_REQUIRED findings authorize the repair. Unexpected PASS(A)
is an honest result but not repair proof; stop rather than manufacture a failure.
Candidate B needs changed content, unchanged authority and fresh B-bound checks
and independent reviewer. Neither PASS(A) nor its receipts may close B.

## Finite budget — unchanged from frozen Phase 4 design

| Allocation | Seconds |
|---|---:|
| Build A | 300 |
| Verification + independent review A | 300 |
| One repair B | 300 |
| Fresh verification + independent review B | 300 |
| Tooling recovery action + success diagnostic | 120 |
| Unallocated headroom | 480 |
| **Cumulative total** | **1800** |

The accepted controller represents these exact values. No implementation evidence
requires a different budget. Headroom is not a top-up, refund, extra repair,
unreserved verification or an additional dispatch entitlement. All external work
has a positive finite reservation before effect, with full conservative settlement
when consumption is unknown. Restarts and new IDs preserve cumulative accounting.

## Exact allowed recovery policy

Only `BLOCKED_TOOLING` with action `restore-ready` is proposed. Actor:
`harness-builder`; tool: `shell`; precise arguments/resources appear in the
envelope below. One attempt per WU, regardless of blocker/dispatch/operation/
execution/session IDs. The durable action claim cannot be repeated after success,
failure or ambiguous outcome. Only successful observed action, PASS
`tooling-ready` receipt bound to A and settled dispatch can resolve the blocker.

No external-fact research or architectural choice is authorized. No installation,
permission changes, new services, broad shell remediation or alternate resource
spelling is allowed. The resource is an isolated non-source fixture, not a third
allowed implementation path. If the fixture directory already exists, stop for
owner review. No cleanup/deletion is authorized by this Epic.

`BLOCKED_PERMISSION`, `BLOCKED_AUTHORITY`, `BLOCKED_SECURITY`, `BLOCKED_SCOPE`,
`NO_PROGRESS` and `BUDGET_EXHAUSTED` are terminal. An unresolved blocker remains
an obligation; a new blocker cannot hide or downgrade it. Audit and settlement
may continue as allowed, but may not launch work or widen permissions.

## Machine-readable proposed envelope

This line is intentionally compatible with the accepted parser. It is inert here:
the controller additionally requires an integrity-checked owner-APPROVED Epic
record in the knowledge index, which has **not** been created for this proposal.

execution_mandate: {"max_wus":1,"total_seconds":1800,"repair_policy":{"version":1,"max_repair_cycles":1,"wu_id":"WU-P4-RESOLVEBINARY-ABSOLUTE-001","wu_contract_path":"docs/proposals/phase-4-runtime/wu-contract.md","wu_contract_hash":"5808858faa80dc8fdc19cfd87306661ddc8e413f790d3d53c34f3623df70aec7","allowed_paths":["src/resolve-binary.js","tests/resolvebinary-executable.test.js"],"verification_contract_hash":"f1d7ae2de6f5ca2ada64f1d62dedb9dddc32c27656fb839aedd350743f1e9753","base_files":[{"path":"package.json","type":"file","mode":"100644","sha256":"67a58a43a0ac909e3d1b6c20a0ab6e07bedf9179e60e978302205766dadc0a1d"}],"build_seconds":300,"repair_seconds":300,"review_seconds":300,"recovery_actions":[{"id":"restore-ready","class":"BLOCKED_TOOLING","actor":"harness-builder","tool":"shell","input":{"command":"node -e 'require(\"node:fs\").writeFileSync(\"/Users/poseidon/Documents/agentic-engineering-tutor-system/agentic-engineering-tutor-system/.harness/execution/runtime-fixtures/phase4-resolvebinary-absolute-v1/ready.txt\",\"READY\\n\",{flag:\"wx\",mode:0o600})'","workdir":"/Users/poseidon/Documents/agentic-engineering-tutor-system/agentic-engineering-tutor-system","timeout":10000},"reserved_seconds":120,"success_check_id":"tooling-ready"}]}}

## Future examination sequence, only after explicit approval

1. Verify the exact committed bootstrap revision is actually loaded in OpenCode;
   inspect live builder/reviewer readiness and baseline fingerprints. A commit
   alone is not loading proof. This preparation has not changed plugin settings.
2. Register the exact owner-approved Epic and derive the one mandate/WU. Freeze
   the declared verification and WU provenance; no replacement or caller override.
3. Fund, prepare and launch real Build A. Record external identity, settle its
   handoff, freeze and record A. Preserve all complete assertions.
4. Record the observed tooling failure; authorize/reserve its one restoration,
   execute the exact action and candidate-bound success diagnostic, settle and
   explicitly resolve. Missing or ambiguous results stop rather than retry.
5. Fund reviewer A, execute all frozen checks and persist the actual independent
   verdict/findings. Only real CHANGES_REQUIRED permits the single repair.
6. Authorize repair durably, then fund/launch it with exactly those stored findings.
   Settle, freeze B and record lineage. B must differ from A within scope.
7. Fund a fresh reviewer B with fresh B receipts for all checks. Only its PASS,
   settled dispatches, current-candidate binding and no blockers permit WU_COMPLETE.
8. Retain fresh-process restart evidence at the contractual boundaries, IDs,
   receipts, findings, counters, budgets, lineage, and ambiguous-launch handling.
   Unknown external outcomes must never be assumed never-launched.

## Terminal chapter report and explicit limits

Maximum autonomous chapter outcome: **EPIC_EXECUTION_VERIFIED**, as an evidence
report for the owner. Do not invoke the controller's Epic `complete` action or
represent this outcome as owner acceptance. Do not create another WU, repair WU,
child/successor WU, automatic re-slice or multi-WU loop. No budget/mandate top-up
or replacement, permission widening, automatic merge, deploy or release.

The real permission-denial scenario remains a **separately owner-authorized
negative probe**, as required by frozen design §11. It is not an additional WU,
not a recovery route, and not implicitly approved by this proposal. Do not poison
the successful WU to obtain that evidence. Until that and every required runtime
gate are separately satisfied, PHASE_4 stays UNVERIFIED even if this Epic's repair
and tooling examination succeeds. Phase 5 remains out of scope.

## Git closure evidence (bootstrap only)

Commit: `d385a84c5cae0e4fdd342ca856b7c434344c486d`.
Git tree: `809b30f0b95d6983d9f42131e03876a44dd39975`.
All 153 candidate files were checked against staged and committed bytes/modes.
They match the accepted candidate exactly. The full Git tree has one additional
owner-accepted post-freeze evidence document (154 files total), so the entire Git
tree is not claimed to be the same 153-file snapshot or the same hash format.
That extra document's SHA-256 is
`596c3107181af446b0e27e20dbeddca7b999c53ad1b124ce90f4a5e8ec6c0fbd`.
Both predecessor candidates remain preserved. Contract/profiles/permissions were
unchanged. Working tree was verified **CLEAN immediately after commit**; these
three proposal documents are subsequent uncommitted preparation only.

The commit changed exactly these 17 files:

```text
docs/phase-4-bootstrap-report.md
docs/phase-4-bootstrap-review-evidence.md
docs/phase-4-bounded-repair-and-blocker-resolution.md
docs/superpowers/plans/2026-09-30-phase-4-bootstrap.md
index.js
scripts/validate-package.mjs
src/execution/constants.js
src/execution/controller-tool.js
src/execution/execution.js
src/execution/index.js
src/execution/ownership.js
src/execution/permission-stops.js
src/execution/repair-policy.js
src/execution/runtime-guard.js
src/execution/state.js
src/project-knowledge.js
tests/execution/phase4.test.js
```

## Owner decision requested — no decision recorded

Review this exact Epic/WU/verification packet, the 1800-second envelope, both
described injections and the sole tooling recovery action. Approve, amend or
reject explicitly. This preparation is not approval. The stop point remains
before artifact approval, WU activation and any runtime examination.

```text
PHASE_4_CONTRACT_GATE = PASS
PHASE_4_BOOTSTRAP = PASS
PHASE_4_BOOTSTRAP_REVIEW = PASS
PHASE_4_RUNTIME_PROOF = PENDING
PHASE_4 = UNVERIFIED
```
