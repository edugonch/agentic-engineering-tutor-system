# Phase 3 — Autonomous WU Controller (Mandate Integration)

> Status: FROZEN CONTRACT (proposal). Owner approval required before bootstrap.
> Predecessors: PHASE_0 = PASS, PHASE_1 = PASS, PHASE_2 = PASS (`bb1cc03a…`).

## 1. Objective

Demonstrate, for the first time, that **one real Work Unit can move from mandate-derived
authorization through independent verification to durable closure, with no human
intervention in between, using the Phase 2 durable controller**.

This phase is NOT about completing an Epic. It is a thin vertical slice: one mandate,
one Work Unit, one candidate, one review, one durable completion.

Critically, this phase has **two distinct moments**, and they must never be collapsed:

```text
3A  BOOTSTRAP INTEGRATION        (infrastructure work, explicitly authorized)
        ≠
3B  FIRST GOVERNED WU           (the actual end-to-end demonstration)
```

## 2. The bootstrap problem (why 3A ≠ 3B)

The natural first candidate for a "governed WU" is the work that exposes the WU
lifecycle itself. That is circular:

```text
WU-01 implements the surface
needed to govern WU-01
```

`WU_ACTIVATE`, `RECORD_REVIEW`, and `COMPLETE` are implemented in the durable core's
`applyEvent` but are **not yet exposed by `harness_execution_controller`**. Therefore
a WU whose deliverable is "expose WU activation" cannot be activated by the very
surface it is building.

Resolution: split the phase.

- **3A — Bootstrap integration** is ordinary infrastructure work, authorized explicitly
  by the owner as Phase 3 work. It is tested, smoke-tested, reviewed, and committed
  like any other change — but it is **not claimed** as the first autonomous WU.
- **3B — First governed WU** is a real, small, verifiable piece of the Harness itself
  (not a fixture), driven end-to-end by the now-complete controller.

## 3. Existing primitives — audit against Phase 3

### 3.1 Already satisfied by construction (do not rebuild)

The Phase 2 durable core (`src/execution/state.js`) already implements every
operation type the WU lifecycle needs:

| Operation | `applyEvent` | Tool action today |
|---|---|---|
| `MANDATE_APPROVE` | ✅ | ✅ (`init`) |
| `WU_ACTIVATE` (`authorization = AUTHORIZED_BY_MANDATE`) | ✅ | ❌ |
| `PHASE_START` / `PHASE_END` (billing) | ✅ | ❌ |
| `DISPATCH_RESERVE` / `PREPARE` / `LAUNCH` / `FINISH` / `RECONCILE` / `RELEASE` / `MARK_AMBIGUOUS` | ✅ | ✅ |
| `FREEZE_CANDIDATE` | ✅ | ❌ |
| `RECORD_REVIEW` (hash-bound) | ✅ | ❌ |
| `CHECKPOINT` / `BLOCK` / `COMPLETE` | ✅ | ❌ |

Also already present and reusable:

- `commit()` with `operation_id` + `expected_revision` + `holder_session_id` +
  `lease_fencing_token` (Phase 2, v2 operation identity).
- `recover()` read-only classification; `verify()` projection-rebuild invariant check.
- `harness_freeze_candidate` → content-addressed candidate registry
  (`src/execution/candidate-registry.js`: immutable blobs + `cand-<sha256>.json`,
  idempotent re-store, `CANDIDATE_REGISTRY_CONFLICT` on divergent reuse).
- `harness_run_verification`, `harness_check_execution_readiness`,
  `harness_check_agent_readiness`, `harness_validate_story`.
- Subagents `harness-builder` and `harness-reviewer` (both `ready`).

### 3.2 What must actually change (minimum delta)

The gap is an **integration surface**, not new primitives:

1. Expose WU-lifecycle actions on `harness_execution_controller`.
2. Wire `harness_freeze_candidate` (registry) → durable `FREEZE_CANDIDATE` event.
3. Add `origin = DERIVED` to WU activation state (see §4).
4. Author a real Epic (mandate) + first WU under `governance_only` scaffold.

## 4. Authority model (non-negotiable)

```text
Owner approves Epic mandate
        ↓
MANDATE_APPROVE event RECORDS that approval
        ↓
WU is DERIVED from the mandate
        ↓
WU.origin = DERIVED
WU.execution_authorization = AUTHORIZED_BY_MANDATE
```

- `MANDATE_APPROVE` is a **record of a human decision**, never a self-generated
  approval. The owner is the sole human authority input.
- A derived WU is **never** `APPROVED`. It carries `origin = DERIVED` and
  `execution_authorization = AUTHORIZED_BY_MANDATE`.
- "Who approved this document?" (artifact approval) and "does the controller have
  authority to run this transition?" (execution authorization) must never collapse
  into one field. This is the semantic separation defended since Phase 0.

Delta: `WU_ACTIVATE` in `applyEvent` already sets
`authorization = AUTHORIZED_BY_MANDATE`. Phase 3A renames/clarifies this as
`execution_authorization` and adds `origin: "DERIVED"` (backward-compatible for
existing logs, which have no `origin` field).

## 5. Phase 3A — Bootstrap integration

Explicitly authorized infrastructure work. Deliverable: the controller exposes the
complete WU lifecycle and the freeze path is durable.

### 5.1 New `harness_execution_controller` actions

Each routes through `commit()` (same fencing/CAS/idempotency as Phase 2):

| Action | Operation | Body |
|---|---|---|
| `activate_wu` | `WU_ACTIVATE` | `{ wu_id, mandate_id }` |
| `record_candidate` | `FREEZE_CANDIDATE` | `{ candidate_id, manifest_hash, tree_hash, manifest }` |
| `record_review` | `RECORD_REVIEW` | `{ candidate_id, verdict, candidate_hashes, reviewer }` |
| `checkpoint` | `CHECKPOINT` | `{ note }` |
| `block` | `BLOCK` | `{ class, reason }` |
| `complete` | `COMPLETE` | `{ result }` |

`phase_start` / `phase_end` are deferred unless billing a phase is required by 3B
(3B's WU is a code change measured by dispatch consumption, not phase time).

### 5.2 Freeze wiring

`harness_freeze_candidate` stores immutable content in the registry. The controller
gains a `record_candidate` action that **binds** the resulting `candidate_id` and
hashes into the durable event log. Authority split:

- **registry** = authoritative for immutable content (blobs, tree);
- **event log** = authoritative for lifecycle (which WU froze which candidate, and
  whether a review bound to it).

`record_candidate` never re-hashes or mutates the registry; it references the stored
candidate by id + hashes and fails closed on any hash mismatch.

### 5.3 Acceptance for 3A

- Suite green; `npm run validate` green.
- Runtime smoke: a WU can be `activate_wu` → `record_candidate` → `record_review`
  → `complete` through the tool, with `recover`/`verify` clean at each step.
- Restart recovery preserves the WU state and the candidate binding.
- Reviewed and committed. **Recorded as bootstrap, not as the autonomous-WU demo.**

## 6. Phase 3B — First governed WU (real)

Candidate WU-01: **harden `resolveBinary` to verify the executable bit**.

- Present behavior (`index.js` `resolveBinary`): iterates `PATH`, returns the first
  path where `existsSync(candidate)` is true. A non-executable file is therefore
  reported READY, which is wrong for the readiness gate that checks required binaries.
- Change: additionally require the executable bit (any `0o111` bit), so a path that
  exists but is not executable is not treated as a usable binary.
- Properties: small, single-function, verifiable, no architecture change, already
  registered as Phase 1 debt.

Full governed lifecycle:

```text
Mandate (MANDATE_APPROVE, owner-approved)
  → activate_wu (WU_ACTIVATE: origin=DERIVED, AUTHORIZED_BY_MANDATE)
  → readiness (harness_check_execution_readiness)
  → budget reserve (DISPATCH_RESERVE)
  → builder dispatch (harness-builder)
  → candidate freeze (harness_freeze_candidate → registry)
  → record_candidate (FREEZE_CANDIDATE event)
  → reviewer executes checks (harness-reviewer / harness_run_verification)
  → record_review (RECORD_REVIEW, hash-bound)
  → COMPLETE (PASS)  — or —  BLOCK → bounded repair → new candidate → fresh review
  → durable closure; restart recovery at a designated point
```

## 7. WU lifecycle mapping

| Step | Surface | Durable operation |
|---|---|---|
| mandate | `harness_execution_controller init` | `MANDATE_APPROVE` |
| derive/activate | `activate_wu` | `WU_ACTIVATE` |
| readiness | `harness_check_execution_readiness` | (diagnostic, not authoritative) |
| budget reserve | `reserve` | `DISPATCH_RESERVE` |
| build | `harness-builder` subagent | — |
| freeze | `harness_freeze_candidate` + `record_candidate` | `FREEZE_CANDIDATE` |
| review | `harness-reviewer` + `harness_run_verification` | — |
| record review | `record_review` | `RECORD_REVIEW` |
| close | `complete` / `block` | `COMPLETE` / `BLOCK` |

## 8. Integration: candidate registry vs event log

Two authorities, one direction of truth:

- Content (what the WU produced) → registry (`cand-<sha256>`), immutable.
- Lifecycle (what happened to it) → event log, reconstructible.
- The review (`RECORD_REVIEW`) binds to `candidate_id` + `manifest_hash` +
  `tree_hash`, so a review can never accredit a different candidate (already enforced
  in `applyEvent`).

A WU may produce candidate B after a `CHANGES_REQUIRED` review: a new `FREEZE_CANDIDATE`
and a fresh `RECORD_REVIEW` against the new hashes. The old candidate remains immutable
history; only the latest binding drives `COMPLETE`.

## 9. Restart / fault model for the WU lifecycle

- Every step is an append-only event; projection always rebuilds from the log.
- `recover()` classifies each dispatch (NEVER_LAUNCHED / FINISHED_UNRECONCILED /
  AMBIGUOUS / …). WU-level restart reads the projected WU + dispatch ledger.
- `AMBIGUOUS` on a BUILD/REVIEW dispatch retains its reservation and requires
  investigation; it never auto-relaunches.
- A crash between `record_candidate` and `record_review` is recoverable: the candidate
  is durably frozen, the review simply has not yet bound. No double-freeze
  (registry idempotency) and no double-review (idempotent `record_review`).

## 10. Exit conditions (Phase 3 acceptance)

1. `governance_only` scaffold initialized (story, charter, state, epics/, work-units/,
   governance templates) without touching agents/skills/OpenCode config.
2. Phase 3A bootstrap: full WU lifecycle exposed; freeze→registry→event wired;
   suite + validate green; runtime smoke; review; commit.
3. Phase 3B: WU-01 (`resolveBinary` executable-bit) completes end-to-end under the
   controller — mandate → activate → reserve → build → freeze → review → complete —
   with no human intervention between activation and durable closure.
4. Runtime restart recovery demonstrated at least once mid-lifecycle.
5. `verify.passed = true` at completion; projection reconstructible from the log.
6. Budget reserved/consumed is balanced (no unknown consumption, no silent overrun).
7. Authority preserved: WU recorded as `origin=DERIVED`,
   `execution_authorization=AUTHORIZED_BY_MANDATE`; never `APPROVED`.

## 11. Minimum implementation delta (3A)

- `src/execution/controller-tool.js`: add `activate_wu`, `record_candidate`,
  `record_review`, `checkpoint`, `block`, `complete` actions.
- `src/execution/state.js`: clarify `authorization` → `execution_authorization`; add
  `origin: "DERIVED"` on `WU_ACTIVATE`.
- `src/execution/execution.js`: expose the already-implemented transitions through the
  new tool surface (no new state machine logic).
- Freeze wiring: `record_candidate` references a registry-stored candidate by id +
  hashes; fails closed on hash mismatch.
- `index.js`: `resolveBinary` executable-bit check (this lands as WU-01 in 3B, NOT in
  the bootstrap; it is the governed payload, not infrastructure).
- Tests: controller-tool actions + freeze wiring + authority/origin; suite + validate.

## 12. Resolved design decisions

- **3A ≠ 3B.** The bootstrap is infrastructure, explicitly authorized, and is never
  claimed as the autonomous-WU demonstration.
- **First WU = real Harness improvement**, not a fixture: `resolveBinary` executable
  bit (Phase 1 debt).
- **Authority separation.** `MANDATE_APPROVE` records owner approval; the WU is
  `DERIVED` + `AUTHORIZED_BY_MANDATE`, never `APPROVED`.
- **Two-authority candidate model.** Registry owns immutable content; event log owns
  lifecycle; review binds to both via hashes.
- **Plugin pinned to SHA** for architecture/validation work (no `#main` ambiguity).

## 13. 3A review amendments

The 3A review round found the original bootstrap incomplete for real autonomy. The
following amendments supersede the matching parts of §5–§11 above (the original
contract is preserved as history, not silently rewritten):

- **`record_candidate(candidate_id)` is registry-bound.** The caller cannot supply
  authoritative hashes. The action loads the candidate from the registry, fails closed
  on a missing candidate, derives `manifest_hash`/`tree_hash`/`manifest`, and binds the
  candidate to the active `wu_id`.
- **`WU_COMPLETE ≠ COMPLETE`.** `complete_wu` closes one WU with structural
  preconditions; `COMPLETE` remains Epic-level (`EPIC_EXECUTION_VERIFIED`) and is
  rejected while an active WU is incomplete.
- **Activation / max-WU enforcement.** `WU_ACTIVATE` rejects a second WU while the
  active WU is incomplete, rejects re-activating the same id, and rejects activation
  beyond `mandate.max_wus`. The projection carries `activated_wu_ids`.
- **Evidence-bound review.** `record_review` requires `verification_evidence_ids[]`
  (immutable `harness_run_verification` receipts) and validates that each cited receipt
  belongs to the candidate, matches the contract hash, and is `PASS`. A `PASS` can no
  longer be declared by the caller alone.
