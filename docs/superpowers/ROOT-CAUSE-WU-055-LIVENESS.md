# Root-Cause Report: WU-055 / Harness Epic Liveness Failure

## Observed failure

During EPIC-03 / WU-055 in `alfran-web-platform`, the Harness stopped after an
independent review returned bounded technical rework (`REVIEW_REWORK_REQUIRED`).

- Epic: `EPIC-03`
- WU: `WU-055`
- PR: `#151`
- Candidate: `401a01e9ca803853bb9e40b0c0c1379d92c17d63`
- Review result: `REVIEW_REWORK_REQUIRED`
- Fresh findings: 2 bounded technical design issues (no business-policy decision)
- CI: repository-wide Prettier failed on 8 files unchanged by WU-055

The Harness returned control to the owner instead of continuing the Epic
autonomously.

## Exact component and rule causing the stop

Two separate rules contributed:

### 1. Hard one-repair stop

**File:** `src/execution/repair-policy.js`

- `validateRepairPolicy` required `max_repair_cycles ∈ {0, 1}`.
- `beforeRepairEvent` for `REPAIR_AUTHORIZE` stopped with
  `NO_PROGRESS / REPAIR_LIMIT_REACHED` as soon as
  `repair_cycle_count >= max_repair_cycles`.

This is a durable-core rule, not a prompt suggestion. The second bounded repair
required by WU-055 was rejected regardless of whether the new findings were
different, smaller, or technically deterministic.

### 2. Prompt-level "no repair chain" instruction

**File:** `templates/.opencode/agents/harness-orchestrator.md`

> "Do not let review spawn a repair chain: the builder may address only findings
> inside the same approved WU and budget."

**File:** `templates/AGENTS.md`

> "Never treat a repair, review finding, or discovered prerequisite as
> authorization for more work."

These instructions reinforced the hard stop and gave the orchestrator no
 vocabulary for distinguishing bounded technical rework from an owner decision.

### 3. No baseline CI distinction

The durable core had no operation to classify CI failures. A repository-wide
format failure on files unchanged by the candidate was treated as a candidate
failure. Because fixing the baseline would exceed the one-document WU scope, the
system classified further repair as `WORK_UNIT_TOO_BROAD` and stopped.

### 4. No Epic continuation primitive

The controller tracked one active WU and stopped after `WU_COMPLETE`. There was
no durable `epic_continue` action, no WU queue, and no post-merge JIT refresh
mechanism. Even if WU-055 had passed, the Epic would not have autonomously
selected the next authorized WU.

## Why it behaved that way

The Phase 4 design contract explicitly chose `max_repair_cycles = 1` as a
simplification: "One correction is sufficient to demonstrate A → B and restart
safety. A second cycle adds cost and loop complexity without being necessary for
the acceptance demonstration." (`docs/phase-4-bounded-repair-and-blocker-resolution.md`,
section 4).

That was correct for a single-WU acceptance demo, but it institutionalized a
"Work Unit execution with safety circuit breakers" model. The orchestrator was
told to stop after any rework, and the durable core had no mechanism to express
"this is bounded, authorized, converging engineering work; continue the Epic."

## Whether behavior matched current specification

Yes. The failure was spec-compliant. The current specification was intentionally
limited to one repair cycle and explicit owner continuation. The WU-055 case
exposed that the specification is insufficient for autonomous Epic completion.

## What changed

The durable execution core now supports:

1. **Convergence-based repair** via `repair_convergence_budget` and progress
detection (fewer findings, fewer high-severity findings, no repeated/oscillating
signatures).
2. **CI classification** via `ci_classify`, distinguishing
`CANDIDATE_CHANGED`, `BASELINE_UNCHANGED`, `ENVIRONMENT`, and `EXTERNAL`.
3. **Baseline remediation lane** via `baseline_remediate`.
4. **Owner decision gate** via `request_owner_decision` →
`OWNER_DECISION_REQUIRED`.
5. **Epic continuation** via `wu_queue` in the approved mandate and the
`epic_continue` action.

All changes preserve fail-closed authority: the Harness still stops for missing
authority, non-convergence, budget exhaustion, and external blockers.

## Files changed

- `src/execution/constants.js` — new blocker classes and operation types.
- `src/execution/state.js` — Epic cursor, CI classifications, baseline
  remediations, new operation handlers.
- `src/execution/repair-policy.js` — convergence-based repair, CI classify,
  baseline remediate, owner decision request, Epic continue guards.
- `src/execution/controller-tool.js` — new controller actions, summary fields,
  stableHash import.
- `src/execution/execution.js` — recovery output includes Epic/CI state.
- `src/project-knowledge.js` — parse `wu_queue` and `terminal_condition` from
  Epic mandate.
- `src/resolve-binary.js` — fix pre-existing absolute-directory bug.
- `index.js` — tool schema for new controller actions.
- `templates/.opencode/agents/harness-orchestrator.md` — updated liveness
  instructions.
- `templates/AGENTS.md` — updated orchestration rules.
- `docs/phase-4-bounded-repair-and-blocker-resolution.md` — Phase 5 liveness
  extension section.
- `tests/execution/epic-liveness.test.js` — regression scenarios A–I.

## Tests

- New: `tests/execution/epic-liveness.test.js` — 9 scenarios, all passing.
- Existing Phase 4 suite: 37/37 passing.
- Full suite: 345/345 passing (includes pre-existing resolveBinary fix).

## Safety properties preserved

- Explicit authority hierarchy: mandates still bind to approved Epic artifacts.
- Fail-closed semantics: terminal blockers still forbid forward execution.
- No invented Product Owner policy: `OWNER_DECISION_REQUEST` requires a reason
  and stops.
- No silent WU widening: candidate path scoping unchanged; baseline remediation
  is a separate lane.
- Independent review: fresh reviewer required after each repair.
- Immutable candidate identity: candidate hashes and lineage unchanged.
- Real CI state: `ci_classify` records actual classifications; no fake PASS.
- No automatic production deployment.
- Durable audit trail: all new state is event-sourced.
