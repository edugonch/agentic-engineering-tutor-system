# Harness Epic Liveness and Bounded Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the Harness durable execution core from single-WU execution with a hard one-repair stop into autonomous Epic orchestration that can continue through bounded technical rework, baseline CI failures, and WU-to-WU transitions while preserving fail-closed authority boundaries.

**Architecture:** Extend the event-sourced execution controller with Epic-level state (WU queue, completed/blocked tracking, continuation cursor), replace the `max_repair_cycles` integer with a convergence-based repair budget, add CI failure classification into candidate-caused/baseline/environment/external buckets, and expose new controller actions for Epic continuation and baseline remediation. All changes are data-model-first; prompts/profiles are updated only to align with the new machine-enforced semantics.

**Tech Stack:** Node.js 20+, native ESM, `node:test`, existing `src/execution/` event-sourced controller.

---

## Background and Root Cause

The current Harness (Phase 4 design contract) intentionally chose `max_repair_cycles = 1` and instructs the orchestrator to "not let review spawn a repair chain." The durable core enforces this via:

- `src/execution/repair-policy.js:18` — `max_repair_cycles` must be `0` or `1`.
- `src/execution/repair-policy.js:148` — stops with `NO_PROGRESS/REPAIR_LIMIT_REACHED` when `repair_cycle_count >= max_repair_cycles`.
- `templates/.opencode/agents/harness-orchestrator.md:75` — "Do not let review spawn a repair chain."
- `templates/AGENTS.md` — "Never treat a repair, review finding, or discovered prerequisite as authorization for more work."

This proves the current system implements **autonomous Work Unit execution with safety circuit breakers**, not **autonomous Epic orchestration with bounded recovery**. The ALFRAN WU-055 regression case requires a second bounded repair and a baseline CI remediation lane without returning control to the owner.

---

## Task 1: Establish Regression Tests

**Files:**
- Create: `tests/execution/epic-liveness.test.js`
- Modify: (none yet)

**Goal:** Add failing tests for scenarios A–I before touching production code.

- [ ] **Step 1.1: Write scenario A test** — first bounded `CHANGES_REQUIRED` continues autonomously.
- [ ] **Step 1.2: Write scenario B test** — multiple bounded repair cycles converge to PASS.
- [ ] **Step 1.3: Write scenario C test** — non-converging identical finding stops with `NON_CONVERGING_REWORK`.
- [ ] **Step 1.4: Write scenario D test** — CI failure only in unchanged baseline files classifies as `BASELINE_REMEDIATION_REQUIRED`.
- [ ] **Step 1.5: Write scenario E test** — candidate-caused CI failure triggers normal repair.
- [ ] **Step 1.6: Write scenario F test** — business-policy finding stops with `OWNER_DECISION_REQUIRED`.
- [ ] **Step 1.7: Write scenario G test** — accepted WU auto-continues to next authorized WU.
- [ ] **Step 1.8: Write scenario H test** — all WUs accepted yields `EPIC_COMPLETE`.
- [ ] **Step 1.9: Write scenario I test** — fresh session recovers active Epic/WU/candidate/review state and continues.
- [ ] **Step 1.10: Run new tests and confirm they fail for the expected reasons.**

Run: `node --test tests/execution/epic-liveness.test.js`
Expected: multiple failures because `max_repair_cycles > 1`, `BASELINE_REMEDIATION_REQUIRED`, and Epic continuation actions do not exist.

---

## Task 2: Extend Constants and State Model

**Files:**
- Modify: `src/execution/constants.js`
- Modify: `src/execution/state.js`
- Modify: `src/execution/repair-policy.js`

**Goal:** Add new vocabulary and projection fields for Epic-level state, convergence, and CI classification.

- [ ] **Step 2.1: Add blocker classes and operation types.**
  - Add `BASELINE_REMEDIATION_REQUIRED` to `BLOCKER_CLASSES` as a non-terminal, recoverable class.
  - Add `OWNER_DECISION_REQUIRED` to `BLOCKER_CLASSES` as terminal.
  - Add `EXTERNAL_BLOCKED` to `BLOCKER_CLASSES` as terminal.
  - Add operation types: `CI_CLASSIFY`, `BASELINE_REMEDIATE`, `EPIC_CONTINUE`.
  - Update `TERMINAL_BLOCKER_CLASSES` to include `OWNER_DECISION_REQUIRED` and `EXTERNAL_BLOCKED`; exclude `BASELINE_REMEDIATION_REQUIRED`.

- [ ] **Step 2.2: Extend `initialState()` with Epic cursor.**
  - Add `epic` field: `{ wu_queue: [], completed_wu_ids: [], blocked_wu_ids: [], dependencies: {}, next_wu_index: 0, authority_snapshot: null, last_jit_refresh: null, continuation_state: 'ACTIVE', terminal_condition: null }`.
  - Keep existing `wu`, `activated_wu_ids`, `mandate` fields backward-compatible.

- [ ] **Step 2.3: Update repair policy validation.**
  - Allow `max_repair_cycles` to be any non-negative integer up to a convergence budget (e.g., `max_repair_cycles <= 8` and `repair_convergence_budget` optional).
  - Require `repair_convergence_budget >= max_repair_cycles` when specified.
  - Default `repair_convergence_budget` to `max_repair_cycles`.

- [ ] **Step 2.4: Run existing execution tests.**
  - Expect Phase 4 tests that assert `max_repair_cycles === 1` to fail; these are updated in Task 5.

---

## Task 3: Implement Convergence-Based Repair

**Files:**
- Modify: `src/execution/repair-policy.js`

**Goal:** Replace the single-cycle hard stop with loop detection.

- [ ] **Step 3.1: Track finding signatures across cycles.**
  - In `afterRepairEvent` for `RECORD_REVIEW`, store each review's `failure_signature` and `findings_hash` in `wu.repair_history` entries.

- [ ] **Step 3.2: Detect non-convergence before authorizing repair.**
  - In `beforeRepairEvent` `REPAIR_AUTHORIZE`:
    - Allow authorization if `repair_cycle_count < max_repair_cycles` (backward compatibility).
    - If `repair_cycle_count >= max_repair_cycles`, allow authorization only if the new findings demonstrate strict progress vs. all prior cycles:
      - Strictly fewer total findings, OR
      - Strictly fewer high-severity findings, OR
      - No finding signature repeats the immediate prior cycle or any cycle within the last two, AND the union of finding locations is a subset of or disjoint from prior locations (no oscillation).
    - If progress is not demonstrated, stop with `NO_PROGRESS/REPEATED_IDENTICAL_FAILURE` or `NO_PROGRESS/NON_CONVERGING_REWORK` and include the evidence (signatures, counts) in the blocker.

- [ ] **Step 3.3: Add explicit oscillation detection.**
  - If the same set of finding signatures appears in cycles `n` and `n-2` (but not `n-1`), stop with `NO_PROGRESS/OSCILLATING_FINDINGS`.

- [ ] **Step 3.4: Add test for strict progress bypassing the old limit.**
  - Scenario B from Task 1 should now pass.

---

## Task 4: Implement CI Failure Classification

**Files:**
- Modify: `src/execution/candidate.js` (if needed for base comparison)
- Modify: `src/execution/state.js`
- Modify: `src/execution/repair-policy.js`
- Modify: `src/execution/controller-tool.js`

**Goal:** Distinguish candidate-caused vs. baseline CI failures without faking PASS.

- [ ] **Step 4.1: Add `CI_CLASSIFY` operation.**
  - Body: `{ candidate_id, check_id, status, failing_files: [{ path, base_sha256, candidate_sha256, classification }] }`.
  - Classification per failing file: `CANDIDATE_CHANGED`, `BASELINE_UNCHANGED`, `ENVIRONMENT`, or `EXTERNAL`.
  - The caller supplies the classification with evidence; the durable core records it verbatim and enforces structural validity.

- [ ] **Step 4.2: Add `BASELINE_REMEDIATE` operation.**
  - Body: `{ blocker_id, remediation_wu_id, allowed_paths, verification_contract_hash }`.
  - Requires an active `BASELINE_REMEDIATION_REQUIRED` blocker.
  - Creates a derived remediation WU context within the same Epic mandate; the controller tracks it in `state.epic.blocked_wus` and `dependencies`.

- [ ] **Step 4.3: Update `RECORD_REVIEW`/`FREEZE_CANDIDATE` to tolerate baseline failures.**
  - A `CHANGES_REQUIRED` review caused solely by baseline-classified failures must not consume a repair cycle; instead it produces a `BASELINE_REMEDIATION_REQUIRED` blocker.

- [ ] **Step 4.4: Add scenario D and E tests.**

---

## Task 5: Implement Epic Continuation

**Files:**
- Modify: `src/execution/state.js`
- Modify: `src/execution/controller-tool.js`
- Modify: `src/project-knowledge.js` (to parse WU list from Epic)

**Goal:** After a WU is accepted/merged, continue to the next authorized WU.

- [ ] **Step 5.1: Parse WU queue from approved Epic.**
  - Extend `findApprovedEpic` / `approve_mandate` to read `execution_mandate.wu_queue` (ordered array of `{ wu_id, wu_contract_path, dependencies: [] }`).
  - Fall back to single-WU behavior when `wu_queue` is absent.

- [ ] **Step 5.2: Track Epic cursor in state projection.**
  - On `MANDATE_APPROVE`, populate `state.epic.wu_queue` and `state.epic.next_wu_index`.
  - On `WU_ACTIVATE`, advance `next_wu_index` and mark the WU active.
  - On `WU_COMPLETE`, append `wu_id` to `completed_wu_ids`.

- [ ] **Step 5.3: Add `EPIC_CONTINUE` controller action.**
  - Requires no active WU, no unresolved terminal blocker, and `next_wu_index < wu_queue.length`.
  - Auto-activates the next WU whose dependencies are all in `completed_wu_ids`.
  - Records `last_jit_refresh` timestamp and refreshes `authority_snapshot` from the Epic artifact.

- [ ] **Step 5.4: Update `COMPLETE` to enforce Epic terminal condition.**
  - Allow `COMPLETE` only when all queued WUs are in `completed_wu_ids` and a terminal acceptance condition is recorded.

- [ ] **Step 5.5: Add scenario G and H tests.**

---

## Task 6: Update Durable Restart/Recovery

**Files:**
- Modify: `src/execution/execution.js`
- Modify: `src/execution/controller-tool.js`

**Goal:** A fresh session can recover the full Epic/WU/candidate/review state from the event log.

- [ ] **Step 6.1: Include new fields in `recover()` output.**
  - Add `epic`, `ci_classifications`, `baseline_remediations` to the recovery summary.

- [ ] **Step 6.2: Add scenario I test.**
  - Simulate restart via `execFileSync` with a fresh process and assert continuation works.

---

## Task 7: Update Prompts and Governance

**Files:**
- Modify: `templates/.opencode/agents/harness-orchestrator.md`
- Modify: `templates/AGENTS.md`
- Modify: `docs/phase-4-bounded-repair-and-blocker-resolution.md`

**Goal:** Align agent instructions with the new machine-enforced liveness model.

- [ ] **Step 7.1: Update orchestrator profile.**
  - Replace "Do not let review spawn a repair chain" with: "For each `CHANGES_REQUIRED` review, classify whether it is auto-repairable, baseline remediation, non-converging, owner decision, or external. Auto-repairable bounded technical findings continue within the Epic; stop only when the convergence detector, authority, safety, or external capability requires it."
  - Add instruction to call `EPIC_CONTINUE` after a WU reaches accepted/merged state and required gates pass.

- [ ] **Step 7.2: Update `templates/AGENTS.md`.**
  - Add paragraph distinguishing recoverable technical rework from owner decisions.
  - Keep "no merge/deploy automatically" unless explicitly authorized.

- [ ] **Step 7.3: Update Phase 4 design contract.**
  - Document new blocker classes, convergence semantics, CI classification, and Epic continuation.

---

## Task 8: Update Existing Phase 4 Tests

**Files:**
- Modify: `tests/execution/phase4.test.js`

**Goal:** Preserve existing safety invariants while allowing the new liveness behavior.

- [ ] **Step 8.1: Adjust tests that assert `max_repair_cycles === 1` as an invariant.**
  - Change them to assert the default remains `1` for legacy policy, but explicitly approved Epics may request higher convergence budgets.

- [ ] **Step 8.2: Keep all safety tests unchanged** (permission, fencing, scope, immutable reviews, sticky blockers).

---

## Task 9: Fix Pre-existing Baseline Test Failure

**Files:**
- Modify: `src/resolve-binary.js`
- Modify: `tests/resolvebinary-executable.test.js` (if test expectation is correct)

**Goal:** Resolve the unrelated but real baseline test failure observed on `main`.

- [ ] **Step 9.1: Confirm `resolveBinary` rejects absolute directories.**
  - Add `info.isFile()` check in the absolute branch.

- [ ] **Step 9.2: Run `npm test` and confirm the previously failing test passes.**

---

## Task 10: Full Validation and Installation Verification

**Files:**
- Modify: `package.json` (bump version if needed)
- Modify: `README.md` (document new behavior)

- [ ] **Step 10.1: Run `npm run validate`.**
- [ ] **Step 10.2: Run `npm test`.**
- [ ] **Step 10.3: Run `npm pack` and inspect package contents.**
- [ ] **Step 10.4: Simulate plugin install/update in a temp directory** by installing the packed tarball and verifying `harness_execution_controller` exposes the new actions.

---

## Deliverables

1. Root-cause report embedded in this plan.
2. Updated state-machine description in `docs/phase-4-bounded-repair-and-blocker-resolution.md`.
3. Committed code changes.
4. Regression tests in `tests/execution/epic-liveness.test.js`.
5. Migration/compatibility notes in updated design contract.
6. Installation verification evidence.
7. Final execution evidence summary.

---

## Compatibility Notes

- Legacy mandates without `repair_policy` continue to work unchanged.
- Existing event logs replay because new fields are additive; old `max_repair_cycles === 1` policies still stop at one cycle unless the approved Epic explicitly raises the convergence budget.
- The `NO_PROGRESS/REPEATED_IDENTICAL_FAILURE` stop remains; only genuinely progressing repairs bypass the old one-cycle ceiling.
