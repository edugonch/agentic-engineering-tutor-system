# Phase 4 Bootstrap Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. This is the owner-authorized bootstrap under the accepted Phase 4 contract, not a new or derived WU. Steps use checkbox syntax for tracking.

**Goal:** Implement the accepted bounded-repair and typed-blocker invariants with verifiable bootstrap evidence; leave the real demonstration behind its separate owner mandate gate.

**Architecture:** Extend the existing event projection and controller, reusing dispatch, candidate and receipt primitives. Bind one WU/approved authority to its durable controller across execution IDs under a project-wide serialization boundary, so identity churn cannot reset limits. Integrate permission denial with durable governed-session bindings and fail-closed dispatch/tool admission.

**Tech Stack:** JavaScript ESM, Node built-in test runner and filesystem primitives, OpenCode V2 plugin hooks.

---

## Task 1 — Durable policy and authority ownership

Files: `src/execution/state.js`, `constants.js`, `execution.js`, focused policy/ownership helpers if needed, `src/project-knowledge.js`, tests under `tests/execution/` and `tests/project-knowledge.test.js`.

- [ ] Write negative tests for duplicate mandate, absent policy, malformed policy, changed execution ID sharing a WU/approved Epic and concurrent activation.
- [ ] Run those tests and retain actual failing output before implementation.
- [ ] Parse and freeze approved envelope; keep old logs replayable and old mandates without recovery entitlement. Serialize cross-controller ownership before committing new governed events.
- [ ] Verify no identity variation grants a second ledger or removes terminal state.

Expected assertion pattern (against a real temporary root and approved artifact):

```js
await assert.rejects(runExecutionController(root, {
  action: 'activate_wu', execution_id: 'other-controller', session_id: 'other-session',
  wu_id: 'WU-1', mandate_id: 'same-mandate',
}), /ownership|already|bound|authority/i)
```

## Task 2 — Repair, reviews and candidate lineage

Files: `state.js`, `controller-tool.js`, `execution.js`, candidate/receipt integration only where needed, focused repair tests.

- [ ] Write failing tests for repair authorization consumption, duplicate replay/conflict, immutable review, changed scope/contract, A-bound receipts used for B, stale fencing and second repair.
- [ ] Implement REPAIR_AUTHORIZE and current candidate/lineage projection. Bind dispatch role and candidate/review IDs; derive repair packet from immutable findings.
- [ ] Require settled authorized repair, changed composed tree, same WU/verification contract, new receipts and fresh independent reviewer session for B.
- [ ] Recreate controller/process across all three restart windows and prove preserved counter/budget and no relaunch.

Assertions after duplicate authorization and repair:

```js
assert.equal(afterReplay.wu.repair_cycle_count, 1)
assert.equal(afterRestart.budget.used_seconds, beforeRestart.budget.used_seconds)
assert.notEqual(candidateB.candidate_id, candidateA.candidate_id)
assert.notEqual(candidateB.tree_hash, candidateA.tree_hash)
```

## Task 3 — Blocker recovery and budget gates

Files: state/controller/policy helpers, focused blocker tests.

- [ ] Write failing tests for all nine classes, sticky terminal state, ID churn, same-attempt crash resume, repeated failure, insufficient budget and zero-cost dispatch.
- [ ] Implement BLOCKER_RECOVERY_AUTHORIZE/BLOCKER_RESOLVE using approved action descriptors and durable evidence, never caller assertions alone.
- [ ] Charge original ledger and preserve already-held reservations; keep settlement possible after stop.
- [ ] Verify no repair/resolution/candidate/PASS/completion bypass and no permission widening.

Negative assertion pattern:

```js
for (const action of ['authorize_repair', 'authorize_recovery', 'complete_wu']) {
  await assert.rejects(runExecutionController(root, { ...input, action }), /blocked|terminal|STOP/i)
}
```

## Task 4 — Tool boundary, permission events and specialist packets

Files: `index.js`, `src/execution/index.js`, controller integration helpers, Harness builder/reviewer templates, plugin hook tests.

- [ ] Write failing tests for permission.rejected routing to the governed WU, restart persistence and alternate controller/session denial, without invoking a denied side effect.
- [ ] Extend schemas with the three accepted actions and required evidence bindings; propagate real session identity at the tool boundary.
- [ ] Route denial to durable controller state before further governed work; use the same fail-closed admission checks for descendants and avoid session-ID spoofing.
- [ ] Update only Harness profiles for exact findings packets, same WU budget and fresh candidate review.

## Task 5 — Bootstrap verification and independent review

- [ ] Run focused fault tests and `npm test`, `npm run validate`, `git diff --check`.
- [ ] Replay accepted Phase 3 logs read-only and record result.
- [ ] Freeze bootstrap candidate with declared node:test and validate checks, including every source/test/validation dependency.
- [ ] Independent harness-reviewer inspects frozen candidate and runs declared verification through harness_run_verification; address confirmed findings and re-freeze if changed.
- [ ] Populate bootstrap report with exact check results, candidate/review evidence, all 13 fault rows and explicit unverified runtime gates.
- [ ] Keep contract hash intact, demonstration WU inactive, plugin pin unchanged until a separately coordinated runtime load.

Verification commands:

```sh
node --test tests/execution/*.test.js
npm test
npm run validate
git diff --check
```

Expected: zero failed tests/checks. Independent review must distinguish bootstrap tests from the pending real repair E2E. Do not claim PHASE_4 PASS.
