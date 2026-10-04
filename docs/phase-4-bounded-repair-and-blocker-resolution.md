# Phase 4 — Bounded repair and typed blocker resolution

> Status: FROZEN DESIGN CONTRACT v1 — implementation not started.
> Frozen before implementation, under the owner's Phase 4 instructions.
> This document does not approve an Epic or activate the proposed runtime WU.
> PHASE_4 = UNVERIFIED. All acceptance evidence below is pending unless stated.

## 1. Initial gate and baseline

- Accepted Phase 3 SHA: `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`.
- Local `HEAD` and `refs/heads/main` both equal that SHA; branch `main`.
- Working tree was clean before this document was created.
- Configured plugin: `git+https://github.com/edugonch/agentic-engineering-tutor-system.git#dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`.
- Runtime evidence: `~/.local/share/opencode/log/opencode.log` records server
  `loading plugin` for that exact pin, including at `2026-10-01T00:26:29.445Z`.
  Its entrypoint is
  `~/.cache/opencode/npm/git-agentic-engineering-tutor-system-2470c32b78d5/1790805769351/node_modules/opencode-agentic-harness/index.js`.
- All 103 tracked packaged files (`index.js`, `package.json`, `README.md`,
  `src/`, `templates/`, `docs/`) compared byte-for-byte against that loaded
  package matched the clean baseline. This is loading-log plus package-content
  evidence, not an inference from configuration alone.
- Installed Harness builder/reviewer profiles match the repository templates.
- Baseline checks in this session: `npm test` = 241 passed, 0 failed;
  `npm run validate` = 68 core paths validated.

Phases 0–3 remain accepted and closed. Historical execution logs must remain
replayable; Phase 4 adds policy without rewriting historical evidence.

## 2. Outcome and scope

Demonstrate a real WU recovering from `CHANGES_REQUIRED` within the original
mandate, WU, scope and cumulative budget, then receiving fresh verification and
an independent review of a different immutable candidate.

There are two delivery stages:

1. Bootstrap the repair/blocker policy, tests and tool/profile integration.
2. Demonstrate it in OpenCode using a separately owner-approved Epic mandate.

Bootstrap is not itself the governed repair demonstration. The runtime WU must
not be created or activated before its mandate exists. General implementation
is delegated to the builder with a bounded contract; independent assessment is
delegated to the reviewer.

Excluded: repair/child/successor/coordination WUs, auto-re-slicing, multi-WU
loops, automatic Epic completion, merge/deploy/release autonomy, generalized
planning, broad research, and the separate global Web-Researcher isolation bug.

## 3. Audited primitives and gaps

Inspected: the Phase 3 contract; execution state/controller/constants; candidate
freeze and registry; verification contracts, runner and receipts; controller,
state, permission-blocker and continuation tests; builder/reviewer profiles.

| Area | Existing primitive | Phase 4 delta |
|---|---|---|
| Authority | Integrity-checked APPROVED Epic, mandate-derived WU | Bind repair/recovery policy to approved envelope; absence grants no recovery |
| Durability | Append-only events, replay, CAS, fencing, operation identity | Durable repair authorizations, counters, blocker attempts and lineage |
| Dispatch | Reserve/prepare/launch/finish/reconcile/release; ambiguous stop | Bind purpose, actor, repair/blocker identity; prevent duplicate semantic dispatch |
| Budget | Cumulative used/reserved, derived available; conservative reconciliation | Gate repair/recovery and positive reservations; prevent mandate replacement/top-up |
| Candidate | Immutable content-addressed registry and hash-bound record | Current candidate pointer, predecessor/successor edges, unchanged WU/contract/scope |
| Review | Candidate-bound receipts; PASS needs full declared check coverage | Persist findings and review identity; prohibit overwrite/relabel of rejected candidate |
| Completion | PASS and settled dispatches required | Only current, unsuperseded candidate; no active repair/blocker |
| Blockers | Typed classes; terminal classes reject forward dispatch | Sticky terminal stop, explicit bounded recovery authorization and resolution |
| Restart | Projection rebuild and dispatch classification | Report repair stage and safe next step without automatic relaunch |

Specific gaps relevant to this phase: `state.reviews[candidate_id]` can be
overwritten by a different core operation; there is no latest-candidate pointer;
`BLOCK` replaces the active blocker; the tool has only one block operation key;
the terminal guard does not cover repair/resolution/completion; findings are not
stored; non-terminal blockers have no bounded transition policy. These are
Phase 4 hardening targets, not a claim that the accepted happy path failed.

## 4. Approved envelope and limits

Choose **`max_repair_cycles = 1`** for Phase 4. One correction is sufficient to
demonstrate A → B and restart safety. A second cycle adds cost and loop complexity
without being necessary for the acceptance demonstration.

The approved Epic must explicitly bind:

- `max_wus`, `total_seconds`, `max_repair_cycles` (0 or 1 in this phase);
- one exact WU contract reference/hash, allowed changed paths and verification
  contract hash; unchanged base files may be included to materialize checks;
- concrete recovery action descriptors: blocker class, action ID, actor/tool,
  allowed resources/arguments, success evidence and finite reservation;
- maximum recovery attempts: one per allowed class per WU, and at most one
  external-fact investigation in the WU, regardless of new blocker IDs;
- any exact external question and source/tool bounds, if research is permitted.

Policy comes from the integrity-checked artifact, never caller overrides.
Legacy mandates remain replayable but receive zero new repair/recovery authority.
Mandate identity, total budget and policy cannot be replaced during execution.
The parser must support the structured envelope unambiguously and reject malformed
policy rather than silently discard fields.

## 5. Repair lifecycle and minimum operations

```text
BUILD → record_candidate(A) → verification(A) → record_review(A)
  PASS → complete_wu(A)
  CHANGES_REQUIRED
    → authorize_repair [durable; same WU and mandate]
    → reserve/prepare_launch/record_launch [purpose=REPAIR]
    → builder receives exactly recorded findings
    → record_finish/reconcile
    → freeze and record_candidate(B)
    → fresh verification(B) → fresh independent record_review(B)
    → PASS → complete_wu(B)
```

Add three semantic operations only:

| Tool action | Event | Why existing events are insufficient |
|---|---|---|
| `authorize_repair` | `REPAIR_AUTHORIZE` | Atomic, review-bound consumption of the WU's repair entitlement |
| `authorize_recovery` | `BLOCKER_RECOVERY_AUTHORIZE` | Atomically binds one allowed action and consumes its attempt |
| `resolve_blocker` | `BLOCKER_RESOLVE` | Records validated resolution evidence; reconciliation alone proves only settlement |

Reuse `BLOCK`, all `DISPATCH_*`, `FREEZE_CANDIDATE`, `RECORD_REVIEW`, and
`WU_COMPLETE`. There is no separate repair WU, repair-launch verb or budget.
`recover` stays read-only and does not mean permission to retry.

Repair authorization requires an active incomplete WU, its current candidate's
immutable `CHANGES_REQUIRED` review with actionable findings, no unresolved
blocker, settled previous work, remaining cycle entitlement and sufficient budget
for repair plus subsequent verification/review. It binds the review event ID,
findings hash, candidate A, WU/mandate/contract hashes, hypothesis and supporting
evidence, and the unique repair dispatch ID.

Increment `repair_cycle_count` when authorization commits, before launch. A crash,
release, restart or new session does not refund this entitlement. An identical
operation retry replays without increment; changed content conflicts. A different
operation ID cannot consume the same review twice. Limit reached means durable
`NO_PROGRESS` with reason `REPAIR_LIMIT_REACHED`, then STOP.

## 6. Durable accounting and candidate/review lineage

Events are canonical. Projection/status/recover must reconstruct:

- WU current candidate, repair cycle count, authorizations and repair stage;
- immutable reviews (event identity, candidate, reviewer session, verdict,
  findings, findings hash, verification IDs and contract hash);
- candidate A `superseded_by` B and B `supersedes` A, reason
  `CHANGES_REQUIRED`, source review and repair authorization;
- repair/recovery dispatch IDs, actors, external session IDs and settlement;
- blocker history, failure signatures, attempts, hypotheses, resolution evidence;
- cumulative budget and the envelope's immutable authority references.

Recording B requires the authorized repair's settled handoff, B != A, a changed
tree (metadata-only re-freeze is not progress), unchanged verification contract,
unchanged WU provenance, and changed paths within the approved envelope. Compare
composed trees, including deletions/modes; do not trust a caller's path summary.
Retain A, its blobs and its review forever. Atomically update lineage and the
current-candidate pointer when recording B.

`CHANGES_REQUIRED` retains PASS/FAIL verification receipts, the exact candidate,
reviewer and actionable findings (stable ID, severity, location/evidence, impact,
focused correction). The repair packet is derived from these stored findings;
the caller cannot substitute a broader task. No new checks or contract edits are
authorized by a finding. Missing required checks return to the owner.

One candidate gets one immutable review record. Identical retry is idempotent;
changing `CHANGES_REQUIRED(A)` to `PASS(A)` is rejected, even under a new operation
ID. B needs newly executed, B-bound receipts and its own review event. Existing
receipt identity already includes candidate ID and execution fingerprint; reuse
this rather than introduce another receipt format without demonstrated need.

Reviewer B is a fresh independent reviewer session, distinct from builder/repair
sessions and reviewer A. Persist dispatch/session references and verify those
bindings. Full cryptographic reviewer identity attestation is separate debt;
runtime evidence must still prove real specialist sessions and outputs.

Only the current unsuperseded candidate with PASS can close the WU. PASS(A)
cannot close B, and selecting an older candidate cannot evade current failure.

## 7. Budget and launch semantics

Use the existing durable ledger:

```text
available_seconds = total_seconds - used_seconds - reserved_seconds
```

All builder, repair, recovery, verification and reviewer execution is charged
within the original envelope. Each external execution has a positive finite
reservation before its side effect. Existing conservative reconciliation consumes
the full reservation when measured consumption is unavailable; do not use a
model estimate to turn unknown work into free work.

Admission must leave room for the declared next verification/review. A held
reservation permits its already-authorized dispatch to proceed; zero unreserved
availability alone must not invalidate that reservation. If no sufficient
authorized funds remain for required new work, persist `BUDGET_EXHAUSTED` and
STOP. Audit and settlement remain possible; no automatic top-up or new mandate.

Prepare before launching; persist returned external identity immediately when
available, then finish and reconcile. One semantic repair/recovery slot binds
one dispatch; alternate IDs cannot launch duplicates. Unknown launch outcome
retains its reservation and becomes ambiguous; do not relaunch it.

## 8. Structured blocker decision table

Limits below are durable WU-level ceilings, not counters reset by new blocker IDs.
Every automatic attempt requires a concrete descriptor in the approved envelope.

| Class | Automatic recovery? | Allowed actor/tool | Budget charged? | Max attempts | Stop condition | Owner required? |
|---|---|---|---|---|---|---|
| BLOCKED_TOOLING | Conditional | Builder or orchestrator; exact approved local recovery action | Yes | 1/WU | No action, unresolved result, repeated failure, ambiguity or insufficient budget | If unresolved |
| BLOCKED_EXTERNAL_FACT | Conditional | harness-researcher; one exact question and approved sources/tools | Yes | 1/WU | No research authority, inconclusive answer or new question needed | If unresolved |
| BLOCKED_ARCHITECTURE | Only pre-approved reversible choice | Orchestrator; named envelope decision and local evidence | Yes for execution | 1/WU | Material new decision or envelope mismatch | For material decision |
| BLOCKED_PERMISSION | Never | None; audit/settlement only | No recovery | 0 | Immediate hard STOP | Yes, outside this automatic execution |
| BLOCKED_AUTHORITY | Never | None; audit/settlement only | No recovery | 0 | Immediate hard STOP | Yes |
| BLOCKED_SECURITY | Never | None; audit/settlement only | No recovery | 0 | Immediate hard STOP | Yes |
| BLOCKED_SCOPE | Never | None; audit/settlement only | No recovery | 0 | Immediate hard STOP; no re-slice | Yes |
| NO_PROGRESS | Never | None; audit/settlement only | No recovery | 0 | Immediate hard STOP | Yes |
| BUDGET_EXHAUSTED | Never | None; audit/settlement only | No recovery | 0 | Immediate hard STOP | Yes |

`BLOCK` stores a stable blocker ID, class, origin dispatch/session, reason,
evidence and normalized failure signature. Terminal state is sticky: a later
recoverable BLOCK cannot downgrade it. No repair, recovery, new candidate
advancement, PASS accreditation or completion may bypass a terminal blocker.
Already-produced evidence and settlement can be retained without advancing work.

A recoverable blocker suspends ordinary work. Authorization admits only its
bound recovery dispatch; successful settlement plus the approved success evidence
permits `BLOCKER_RESOLVE`. Failed attempts remain in history and stop; a fresh ID
does not grant another attempt. Missing evidence never counts as resolution.

Normalize failures by class, failed check/action and affected resource/finding,
excluding incidental timestamps, session IDs and temporary paths. Repetition of
the same failure without a changed, evidence-supported hypothesis produces
`NO_PROGRESS`. A prose claim or different hash/ID alone is not progress. After
repair, compare findings and executed checks to the source review; an identical
unresolved failure stops. The one-cycle ceiling applies even when progress exists.

`permission.rejected` must retain fail-closed behavior and bind to the governed
execution when emitted by its controller/builder/reviewer session. Persist the
terminal stop before permitting subsequent governed work. No alternate tool,
session, resource spelling or execution ID may be used to achieve the denied
action. Tests of rejected transitions are assertions, not actual bypass launches.

## 9. Durable policy versus orchestrator logic

The durable core enforces authority hashes, sticky blockers, attempt/cycle bounds,
candidate/review lineage, immutable reviews, reservations, dispatch uniqueness,
fencing, and completion eligibility. These cannot be prompt-only safeguards.

The orchestrator classifies observed failures with evidence, proposes the exact
in-envelope correction, constructs the findings-derived packet, calls readiness,
dispatches specialists, and evaluates semantic progress. It cannot self-approve
policy or clear a blocker by prose. Deterministic checks validate referenced
records, hashes and action bounds; independent review evaluates semantic scope
and whether a correction genuinely satisfies findings.

Profile changes are limited to Harness repair/handoff/review instructions.
The internal harness-researcher is used only for an authorized exact external
blocker question. Unrelated global agents are outside this contract.

## 10. Proposed first real WU — pending owner mandate

**Proposal: make `resolveBinary` accept an absolute executable path.**

Current `src/resolve-binary.js` only iterates PATH entries and joins each with the
program. A verification contract naming an absolute program path therefore is
not directly checked as that path. Supporting absolute executables is a small,
real readiness improvement, separate from the accepted executable-bit outcome.

Proposed scope: `src/resolve-binary.js` and one focused resolver test file.
Acceptance: an absolute executable regular file resolves with empty or unrelated
PATH; a missing path, directory or non-executable file returns null; current
bare-name PATH search and executable-bit behavior remain covered.

With explicit approval of the fault injection, builder A implements absolute-path
support but intentionally leaves the directory edge case unresolved. The complete
acceptance contract/checks are frozen beforehand and visible to the reviewer.
The real reviewer runs them and decides the verdict independently; never instruct
it to fabricate CHANGES_REQUIRED. The recorded directory finding drives repair
B in the same WU. A fresh reviewer evaluates B against the unchanged contract.
If A unexpectedly passes, record that outcome honestly; it does not prove repair.

Proposed Epic envelope: one WU, 1800 seconds total, one repair cycle. Suggested
reservations: build A 300, verification/review A 300, repair B 300,
verification/review B 300, tooling recovery 120; 480 remains unallocated.
These figures are proposals, not an approved budget. A repeat verification by
the reviewer must fit its reserved execution envelope, not run unaccounted.

Present this candidate and obtain its specific Epic mandate before creating or
activating the WU. Check live specialist readiness before activation. Bootstrap
must be committed and loaded under an exact verified plugin revision before E2E.

## 11. Runtime and restart acceptance

Required repair trace: APPROVED Epic → approve_mandate → activate WU → real BUILD
→ candidate A → verification → real reviewer CHANGES_REQUIRED → durable repair
authorization → real repair builder → candidate B → fresh receipts → fresh
independent reviewer PASS → WU_COMPLETE.

Record IDs/hashes, specialist session outputs, ledger snapshots and verify/recover
results. Prove A != B, same WU/mandate/budget, non-reset counter, no duplicate
dispatch, no scope expansion, and inability to use PASS(A) for B.

Runtime blocker scenarios:

- TOOLING: in an isolated, pre-authorized local test resource, make a required
  transient resource unavailable; execute exactly one declared restoration action;
  record successful diagnostic evidence and resolution, then resume. No installing
  dependencies, changing permissions or accessing new resources implicitly.
- PERMISSION: in a separately authorized negative probe, exercise an actual denied
  harmless operation. Capture `permission.rejected`, durable BLOCKED_PERMISSION,
  no recovery dispatch, no alternate tool/session, and STOP. Do not poison the
  successful WU or attempt the denied action through another route.
- NO_PROGRESS: if practical, repeat the same diagnostic failure under controlled
  injection; record terminal stop rather than another recovery.

Restart means fresh controller/process state replaying durable records. A status
call in the same process alone is not restart evidence. Reconcile known results;
never assume an ambiguous launch was never executed.

## 12. Fault injection matrix

All rows are **PENDING**. Automated fixtures establish invariants; runtime evidence
is additionally required for repair, restart and blocker acceptance.

| # | Injection | Required observable result |
|---|---|---|
| 1 | Restart after CHANGES_REQUIRED before repair | Findings/review/authority intact; one authorization possible |
| 2 | Restart after repair before freeze B | Settled handoff reusable; count/budget preserved; no builder relaunch |
| 3 | Crash after candidate B before review | B remains current; fresh B checks/review still required |
| 4 | Duplicate repair operation ID | Exact replay; changed payload conflicts; count/reservation unchanged |
| 5 | Repair limit reached | Durable NO_PROGRESS/REPAIR_LIMIT_REACHED; no second repair |
| 6 | Budget exhausted during repair | Settlement retained; BUDGET_EXHAUSTED; no unfunded continuation |
| 7 | Fake fresh PASS for same candidate | Rejected review overwrite, even with alternate operation ID |
| 8 | PASS A used to close B | Rejected evidence/closure; only current candidate can complete |
| 9 | Terminal blocker followed by repair/downgrade | Rejected; sticky blocker and history retained |
| 10 | Recovery retried with new blocker/dispatch IDs | WU-level attempt ceiling rejects duplicate recovery |
| 11 | Identical failure without progress | NO_PROGRESS; evidence fingerprint survives restart |
| 12 | Stale controller fencing token authorizes repair | Rejected before event append or side effect |
| 13 | permission.rejected | Durable hard stop; no alternative execution or continuation |

Also check changed-scope/verification-contract candidates, zero-cost dispatch
attempts, mandate budget replacement, semantic duplicate dispatches and replay of
accepted Phase 3 logs. Preserve compatibility through explicit policy/version
handling, not retroactive fabrication of missing history.

## 13. Implementation boundary and final gate

Expected implementation areas: execution state/constants/controller/tool,
approved-envelope parser, tool schemas and governed permission-event binding;
Harness profile templates; focused tests and runtime evidence documentation.
Reuse candidate registry and receipt primitives unless tests demonstrate a gap.
Record contract amendments explicitly before implementing divergent semantics.

Final report must include:

```text
PHASE_4 = PASS | FAIL | UNVERIFIED
exact SHA / branch / loaded plugin SHA
suite / validate
repair E2E evidence
blocker matrix / fault injection matrix
explicit debt / recommended Phase 5 baseline
```

PASS requires all mandatory runtime and fault gates, suite/validate green, real
A → B repair and independent review, preserved budget, restart reconstruction,
typed recovery and fail-closed hard blockers. Unit tests alone cannot grant PASS.

## 14. Phase 5 liveness extension (post-WU-055)

The ALFRAN WU-055 regression exposed that a fixed `max_repair_cycles = 1` stop,
combined with prompt instructions that forbid "repair chains," produces
autonomous Work Unit execution with safety circuit breakers rather than
autonomous Epic orchestration with bounded recovery. The following extensions are
now part of the durable execution core:

### 14.1 Convergence-based repair

- `repair_policy.max_repair_cycles` remains the guaranteed minimum repair
  entitlement, but values up to `8` are accepted.
- `repair_policy.repair_convergence_budget` (>= `max_repair_cycles`, <= `8`)
  allows additional repair cycles when findings demonstrate strict progress:
  reduced total count, reduced high-severity count, or new distinct findings.
- Beyond `max_repair_cycles`, authorization is rejected unless the new review
  strictly improves on every prior cycle. Identical signatures,
  `REPEATED_IDENTICAL_FAILURE`, and `OSCILLATING_FINDINGS` stop with
  `NO_PROGRESS` and durable evidence.
- Legacy policies with `repair_convergence_budget == max_repair_cycles` keep the
  original `REPAIR_LIMIT_REACHED` behavior.

### 14.2 CI failure classification

`harness_execution_controller` action `ci_classify` records per-file
classifications:

- `CANDIDATE_CHANGED` → in-band normal repair.
- `BASELINE_UNCHANGED` (and no candidate-caused failure) →
  `BASELINE_REMEDIATION_REQUIRED` recoverable blocker. The orchestrator may
  authorize a tightly bounded remediation lane via `baseline_remediate`.
- `ENVIRONMENT` → `BLOCKED_TOOLING`.
- `EXTERNAL` → `EXTERNAL_BLOCKED` terminal blocker.

The candidate is never silently marked PASS.

### 14.3 Epic continuation

An approved Epic may declare `execution_mandate.wu_queue`: an ordered array of
`{ wu_id, wu_contract_path, dependencies }`. The controller tracks
`epic.{wu_queue, completed_wu_ids, blocked_wu_ids, next_wu_index,
authority_snapshot, last_jit_refresh, continuation_state}`.

After `complete_wu`, the orchestrator calls `epic_continue` to activate the next
WU whose dependencies are satisfied. `complete` (Epic-level) is allowed only when
all queued WUs are in `completed_wu_ids`.

### 14.4 Owner decision gate

`request_owner_decision` creates a terminal `OWNER_DECISION_REQUIRED` blocker.
Use it when a review exposes missing business policy, contradictory authority,
irreversible operation, or any matter outside the approved Epic mandate.

### 14.5 State machine

```text
EPIC_ACTIVE
  -> MANDATE_APPROVED
  -> WU_ACTIVE
    -> BUILDING
    -> VERIFYING
    -> REVIEWING
      -> PASS -> WU_COMPLETE -> EPIC_CONTINUE -> WU_ACTIVE (next authorized)
      -> CHANGES_REQUIRED (bounded technical) -> REPAIR_AUTHORIZED -> BUILDING (repair) -> VERIFYING -> REVIEWING
      -> BASELINE_REMEDIATION_REQUIRED -> baseline_remediate -> BASELINE_WU -> ... -> resume WU_ACTIVE
      -> OWNER_DECISION_REQUIRED -> STOP (human)
      -> EXTERNAL_BLOCKED -> STOP (external)
      -> NO_PROGRESS (non-converging) -> STOP (human/orchestration)
    -> BUDGET_EXHAUSTED -> STOP
  -> EPIC_COMPLETE
```

### 14.6 Compatibility

Existing event logs replay unchanged. Legacy mandates without `wu_queue` or
`repair_convergence_budget` retain their original one-WU, one-repair behavior.

Current debt: full runtime/fault proof for Phase 5 scenarios is pending; the
WU-055 regression tests now pass at the durable-core level. Recommend verifying
plugin reload and end-to-end Epic continuation before promoting this SHA as a
new baseline.
