# Proposed Epic — Phase 4 bounded runtime repair examination

**PROPOSED — OWNER REVIEW REQUIRED — NO EXECUTION AUTHORITY**

Packet **v1** for the new `-004` identities keeps the accepted runtime
proof scope unchanged and rebinds implementation/WU provenance back to the
already-reviewed Harness-tool transport normalization revision
`bec2876bbcee8e4f48fc9cef81844330680680fe`, with its accepted
controller/freeze/verification transport amendments intact. The later
published recovery Code-Mode transport amendment
`144f5bdb0c9cfbdc3474c280cf5f6960968c8be7` is retained as immutable branch
history but is **not** required by this packet and must **not** be bound by it.
Historical execution `P4-RESOLVEBINARY-ABSOLUTE-003` is STOPPED and immutable:
it recorded candidate A, entered `BLOCKED_TOOLING`, authorized and launched its
one `restore-ready` recovery dispatch, and its native `shell` call was then
rejected before execution because the actor manually reconstructed the action
and introduced one extra logical backslash before `n` (root cause
**ACTOR_INPUT_MISMATCH / DOUBLE_ESCAPING**). The runtime guard correctly refused
the altered input, leaving no `action_claim`, no side effect and no
`action_evidence`. This was **not** a Code Mode wrapper mismatch, a shell tool
identity mismatch or a runtime-guard recovery equality defect. Historical
execution `P4-RESOLVEBINARY-ABSOLUTE-002` and packet `v4` of the `-002` proposal
(`e3928a36`) are likewise immutable history. New explicit owner approval is
required; approval of any earlier packet does not approve these changed bytes.
The superseded `-001` proposal under `docs/proposals/phase-4-runtime/` is
preserved unchanged; its approved bytes are not rewritten.

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
DESIGN_SOUND / R1–R4 PASS. Its reviewed implementation has been committed. The
accepted Harness-tool transport normalization amendment (`bec2876b`) normalized
the six whitelisted Harness tools, added transport-independent backstops at the
real freeze/verification boundaries and deliberately left `shell` outside the
global trusted whitelist. A native, exactly-matching recovery action was already
admitted at that revision: the guard compares the logical tool and its
stable-serialized input in both `beforeTool` (claim before effect) and `afterTool`
(evidence after effect). The `-003` runtime did **not** expose a transport gap.
It exposed an actor error: the recovery specialist invoked the native `shell`
tool but reconstructed its input, double-escaping the node source so the command
differed from the approved action by one extra logical backslash before `n`. The
guard correctly required exact equality and refused to execute the altered action.
The published `144f5bd` amendment assumed the earlier, now-disproved Code Mode
transport hypothesis; it is preserved as history but is not required here.

Runtime proof is still pending. This chapter demonstrates one real outcome:
**resolveBinary supports absolute executable paths**, corrected A → B inside
one WU and budget, with fresh independent evidence and bounded tooling recovery.
It also exercises the accepted Phase 4 admission semantics through real Code
Mode wrappers: the owner freezes candidates and launches work through the
normalized `harness_freeze_candidate`/controller wrappers, and reviewers admit
verification only through the normalized `harness_run_verification` wrapper
bound to a live dispatch. The single approved `shell` recovery is executed
natively as the exact stored logical tool + input, proving that unrecognized
wrappers and altered inputs cannot bypass the real tool boundaries.

## Proposed authority identities

| Field | Exact proposal |
|---|---|
| Epic | `EPIC-P4-RESOLVEBINARY-ABSOLUTE-004` |
| Sole derived WU | `WU-P4-RESOLVEBINARY-ABSOLUTE-004` |
| Future execution ID | `P4-RESOLVEBINARY-ABSOLUTE-004` |
| Future mandate ID | `P4-RESOLVEBINARY-ABSOLUTE-004-MANDATE-001` |
| Mandate revision | Content-addressed revision of this exact Epic artifact when explicitly owner-approved; no fabricated revision now |
| WU contract | `docs/proposals/phase-4-runtime-004/wu-contract.md` |
| WU contract SHA-256 | `85cdf4a3422f35dbd53afa84734c15c8820ea6cd72cf18e9c94221c9bda33cb8` |
| Verification contract | `docs/proposals/phase-4-runtime-004/verification-contract.json` |
| Immutable normative verification hash | `f1d7ae2de6f5ca2ada64f1d62dedb9dddc32c27656fb839aedd350743f1e9753` |
| Implementation/required loaded revision | `bec2876bbcee8e4f48fc9cef81844330680680fe` |
| Changed paths | `src/resolve-binary.js`, `tests/resolvebinary-executable.test.js` only |
| Policy | version 1, `max_wus = 1`, `max_repair_cycles = 1`, cumulative 1800 seconds |

The named WU contract is part of this proposal and defines complete acceptance:
absolute executable with empty/unrelated PATH; missing path null; directory null;
non-executable file null; simple-name PATH search and executable-bit semantics
preserved. Approval binds that exact document and the complete frozen verification
commands, not a shortened summary or a substitute task. Approved artifact metadata
would carry owner authority without editing these proposed contract bytes.

After v1 owner approval, use the amended exact registration inputs:
`content_source_path = docs/proposals/phase-4-runtime-004/epic.md` and
`expected_content_sha256 = SHA256(the exact owner-approved v1 Epic bytes)`.
Do not supply model-generated `content`. The stored archive/revision must match
that approved digest; any mismatch stops authority derivation.

## Explicit proposed injection authority

Upon owner approval, this Epic explicitly authorizes the two bounded injections
described in its WU contract:

1. Builder A may deliberately leave the absolute-directory case unresolved while
   retaining all acceptance assertions. The independent reviewer runs **all**
   frozen checks and decides the verdict. No instruction to fabricate
   CHANGES_REQUIRED, suppress a result or reclassify BLOCKED/PASS is authorized.
2. Within Build A's reservation, ensure the named private tooling fixture parent
   exists with `ready.txt` absent. After recording A, use that actual observed
   absence for BLOCKED_TOOLING and one exact approved restoration, before
   reviewer A. The parent directory may already exist as acknowledged historical
   `-003` evidence; it must not be deleted or modified, and only `ready.txt` must
   be absent at preflight.

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

The recovery is admitted only when it arrives as the exact approved native
logical action — the tool named by `recovery.action.tool` with the exact logical
input object bound in the envelope — compared by exact tool + stable-serialized
input in both `beforeTool` (claim before effect) and `afterTool` (evidence after
effect). The `shell` tool is not added to the global trusted whitelist and no
generic execute privilege is granted. No coercion, defaulting, partial match,
extra/omitted key, alternate command spelling, reconstruction or re-escaping is
accepted.

No external-fact research or architectural choice is authorized. No installation,
permission changes, new services, broad shell remediation or alternate resource
spelling is allowed. The resource is an isolated non-source fixture, not a third
allowed implementation path. If `ready.txt` is already present, stop for owner
review. No cleanup/deletion is authorized by this Epic.

`BLOCKED_PERMISSION`, `BLOCKED_AUTHORITY`, `BLOCKED_SECURITY`, `BLOCKED_SCOPE`,
`NO_PROGRESS` and `BUDGET_EXHAUSTED` are terminal. An unresolved blocker remains
an obligation; a new blocker cannot hide or downgrade it. Audit and settlement
may continue as allowed, but may not launch work or widen permissions.

## Recovery execution instruction (no new authority)

This prose clarifies execution only; it does not alter recovery authority or the
machine-readable descriptor below. When executing the approved recovery action,
the recovery specialist must use the native OpenCode tool named by
`recovery.action.tool`. For `restore-ready`, `tool = shell`. The specialist must
**not** manually reconstruct, re-escape, normalize, prettify or rewrite
`recovery.action.input`. It must invoke the native `shell` tool with the exact
logical input object stored in durable recovery authority. Before the side
effect, the runtime guard remains responsible for exact tool + input identity and
for the durable `action_claim`. A mismatch is an honest STOP, never permission to
retry.

## Explicit `-004` runtime gate

The future `-004` runtime examination must report the exact native `shell` call
input before/at invocation and establish:

```text
stableSerialize(actual native shell input) === stableSerialize(recovery.action.input)
```

It must then require, in order:

```text
recovery_action_claim
  -> native shell executes once
  -> recovery_action_evidence PASS
  -> tooling-ready PASS
  -> settle recovery
  -> resolve blocker
```

Any mismatch is a STOP. `restore-ready` must **not** be routed through Code Mode
`tools.shell`; the real `-003` runtime proved that recovery actors invoke `shell`
natively.

## Machine-readable proposed envelope

This line is intentionally compatible with the accepted parser. It is inert here:
the controller additionally requires an integrity-checked owner-APPROVED Epic
record in the knowledge index, which has **not** been created for this proposal.

execution_mandate: {"max_wus":1,"total_seconds":1800,"repair_policy":{"version":1,"max_repair_cycles":1,"wu_id":"WU-P4-RESOLVEBINARY-ABSOLUTE-004","wu_contract_path":"docs/proposals/phase-4-runtime-004/wu-contract.md","wu_contract_hash":"85cdf4a3422f35dbd53afa84734c15c8820ea6cd72cf18e9c94221c9bda33cb8","allowed_paths":["src/resolve-binary.js","tests/resolvebinary-executable.test.js"],"verification_contract_hash":"f1d7ae2de6f5ca2ada64f1d62dedb9dddc32c27656fb839aedd350743f1e9753","base_files":[{"path":"package.json","type":"file","mode":"100644","sha256":"67a58a43a0ac909e3d1b6c20a0ab6e07bedf9179e60e978302205766dadc0a1d"}],"build_seconds":300,"repair_seconds":300,"review_seconds":300,"recovery_actions":[{"id":"restore-ready","class":"BLOCKED_TOOLING","actor":"harness-builder","tool":"shell","input":{"command":"node -e 'require(\"node:fs\").writeFileSync(\"/Users/poseidon/Documents/agentic-engineering-tutor-system/agentic-engineering-tutor-system/.harness/execution/runtime-fixtures/phase4-resolvebinary-absolute-v1/ready.txt\",\"READY\\n\",{flag:\"wx\",mode:0o600})'","workdir":"/Users/poseidon/Documents/agentic-engineering-tutor-system/agentic-engineering-tutor-system","timeout":10000},"reserved_seconds":120,"success_check_id":"tooling-ready"}]}}

## Future examination sequence, only after explicit approval

1. Verify the exact committed bootstrap revision is actually loaded in OpenCode;
   inspect live builder/reviewer readiness and baseline fingerprints. A commit
   alone is not loading proof. This preparation has not changed plugin settings.
2. Register the exact owner-approved Epic and derive the one mandate/WU. Freeze
   the declared verification and WU provenance; no replacement or caller override.
3. Fund, prepare and launch real Build A. Record external identity, settle its
   handoff, freeze and record A. Preserve all complete assertions.
4. Record the observed tooling failure; authorize/reserve its one restoration,
   execute the exact native `shell` action (no reconstruction/re-escaping) and the
   candidate-bound success diagnostic, settle and explicitly resolve. Missing or
   ambiguous results stop rather than retry.
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
proposal documents are subsequent uncommitted preparation only.

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

## Amendment provenance

The reviewed combined emergency-cap and controller-transport amendment is
committed at `384bd085fa31085456ac1f2552ad922d2f43e74a` on
`phase-4-bounded-repair`, with frozen candidate
`cand-13698b4ef2770af293ac5e3e50e6fbe3cb8b5b23b724301c432cf253f081d741`
(manifest `a6701095aea34177ce04a58d5ef231522c49ca98312b0c66c274385769ae1580`,
tree `2cbca948e22f881f444654fd97024c5b9de9b504a30d1a2bcf75d6dea4a0595b`). All six
declared checks passed through `harness_run_verification` and a fresh independent
`harness-reviewer` returned PASS.

The subsequent reviewed Q1 controller authority-boundary correction is committed
at `b471c6092ef346f5557655bdfb3a67660e3be437` on `phase-4-bounded-repair`, with
frozen candidate
`cand-9f7dc2229ebb261b695c3093a09a55dce6a4e8fad104db5122fb0da1437c514c`
(manifest `3282879d2a0f7f796e473f87289290eeb1d95089d2aeea5d68bf4f6365b15c3f`,
tree `13fe0e2f94eb94008c850ed7971b30398367daa3c6b7cec303afe7ad4c9bf79c`). It moves
the specialist controller-mutation guarantee to the real
`harness_execution_controller` tool boundary so an unrecognized Code Mode wrapper
cannot bypass it. All six declared checks passed and a fresh independent
`harness-reviewer` returned PASS; evidence is recorded in
`docs/phase-4-combined-amendment-review-evidence.md`.

The focused Code-Mode Harness-tool transport normalization amendment is
committed at `bec2876bbcee8e4f48fc9cef81844330680680fe` on
`phase-4-bounded-repair`, with frozen candidate
`cand-18dfe194bc1b211daf2f365afce723e85b00654c5b7e977ecfa6e26b29a0b352`
(manifest `35a557f81f420dfebcb0f52af8eaffc8a3ebf648df6819c3b7a9a9fa218c47f6`,
tree `bfd748bd1d04f619c9a581577f2e58e2731b3aa374963fbcef3963a869355e54`).
It generalizes the strict structural Code Mode parser to normalize exact
single-tool wrappers for the six whitelisted Harness tools and adds
transport-independent backstops at the real `harness_freeze_candidate`
and `harness_run_verification` boundaries. All six declared checks passed
and a fresh independent `harness-reviewer` returned PASS.

The focused recovery Code-Mode transport amendment was written under the initial,
now-disproved hypothesis that `-003`'s native `shell` recovery had been denied at
the Code Mode transport boundary. It is committed and published at
`144f5bdb0c9cfbdc3474c280cf5f6960968c8be7` on `phase-4-bounded-repair` and is
retained as immutable branch history. The raw `-003` session export proved the
actual root cause instead: the actor used the native `shell` tool with matching
tool identity, workdir and timeout, and only the command string differed by one
extra logical backslash before `n` (ACTOR_INPUT_MISMATCH / DOUBLE_ESCAPING). The
guard's exact-equality check was correct. This `-004` packet therefore does not
require or bind `144f5bdb`; its required loaded revision is the reviewed ancestor
`bec2876bbcee8e4f48fc9cef81844330680680fe`. The published commit is not removed,
rewritten or force-pushed. The `-001` proposal and its approved artifact bytes
under `docs/proposals/phase-4-runtime/` remain preserved and are not rewritten by
this `-004` packet.

## Historical execution status (immutable)

- `P4-RESOLVEBINARY-ABSOLUTE-002` is an immutable historical STOPPED execution.
  Packet `v4` of the `-002` proposal (`e3928a36`) is preserved unchanged.
- `P4-RESOLVEBINARY-ABSOLUTE-003` is an immutable historical STOPPED execution.
  It reached, in order: loaded revision PASS; Epic/mandate/WU PASS; Build A PASS;
  Candidate A PASS; real owner wrapped freeze PASS; `BLOCKED_TOOLING`; recovery
  authorization and dispatch. Its native `shell` call was then rejected before
  execution because the actual input was double-escaped relative to the approved
  action. No `action_claim`, no side effect and no `action_evidence` were recorded.
  This is **not** a runtime implementation failure, a Code Mode wrapper mismatch,
  a shell tool identity mismatch or a runtime-guard recovery equality defect.

## Owner decision requested — no decision recorded

Review this exact Epic/WU/verification packet, the 1800-second envelope, both
described injections and the sole tooling recovery action. Approve, amend or
reject explicitly. This preparation is not approval. The stop point remains
before artifact approval, WU activation and any runtime examination.

```text
PHASE_4_CONTRACT_GATE = PASS
PHASE_4_BOOTSTRAP = PASS
PHASE_4_BOOTSTRAP_REVIEW = PASS
PHASE_4_COMBINED_AMENDMENT = PASS
PHASE_4_Q1_AUTHORITY_BOUNDARY = PASS
PHASE_4_TRANSPORT_NORMALIZATION = PASS
PHASE_4_RECOVERY_TRANSPORT_AMENDMENT = PUBLISHED_HISTORICAL_NOT_BOUND
PHASE_4_EXECUTION_002 = STOPPED_IMMUTABLE
PHASE_4_EXECUTION_003 = STOPPED_IMMUTABLE_ACTOR_INPUT_MISMATCH
PHASE_4_RUNTIME_PROOF = PENDING
PHASE_4 = UNVERIFIED
```
