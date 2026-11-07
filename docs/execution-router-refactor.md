# Harness simplification: execution router and delivery-first refactor

## Goal

Make the Harness deliver complete, verified WUs with fewer model decisions and
less orchestration overhead. Keep the event journal, exact authority, budget,
fencing, real verification, independent review and governed merge unchanged.

## First refactor: one pure routing decision

The previous code independently reconstructed execution/dispatch decisions in:

- `operational-view.js` (public next action)
- `progress.js` (supervisor wake/triage hash)
- `supervisor.js` (repeated blocker/dispatch checks)

`src/execution/workflow-router.js` is now the single pure read-only classifier
for these functions:

- `routeExecution(state, {events})`: phase, next action, candidate/dispatch
  summary, review-repair ordering, remaining budget.
- `classifyContinuation(state)`: one authoritative triage mode for the
  supervisor and progress hash.
- `hasPendingSupervisorDispatch(state)`: preserves the existing distinction
  between in-flight dispatches and finished ones requiring reconciliation.

The public `projectOperationalView` retains the previous fields, ordering and
unknown-value behavior; the supervisor keeps its current authority and fencing
checks. No new storage, journal operation, guard or owner decision is added.
A route is a recommendation; it never authorizes a side effect.

## Non-regression gates

The router's tests assert all major old actions (new builder, launched child,
reviewer, finished/ambiguous launch, review and merge, blockers, budgets, WU
completion), after-review repair ordering, supervisor hash identity, and
read-only/no-mutation properties. Existing operational-view, supervisor,
controller and recovery test suites must all pass on Node 20, 22 and 24, along
with recovery/source mutation checks.

## Next refactor boundaries (not implemented in this PR)

1. **Measure first.** Instrument useful developer work vs orchestration,
   repeated tool calls and billable interruption losses; establish a baseline
   for E05-27-E and a comparable stable WU. Do not claim productivity gains
   from code relocation alone.
2. **Shrink system prompts.** De-duplicate the current long orchestrator
   instructions by extracting stable role invariants and context-specific
   procedures. Make loading conditional and test that mandatory security and
   acceptance instructions remain present.
3. **Consolidate recovery.** Use a single evidence classification pipeline,
   with live runtime effect verification. Retire ad-hoc shell syntax additions
   only when real execution canaries demonstrate equivalent protection.
4. **Close the loop.** Observe runtime time-policy and restart causes; ensure
   stability holds produce a single scheduled continuation rather than a
   manual prompt. Preserve durable CAS and per-dispatch accounting.
5. **Delivery criterion.** Accept the refactor only when one complete WU and
   a small controlled batch have been delivered end-to-end with fewer
   orchestration turns, no extra approved scope, and complete test/review/merge
   receipts.

Refactoring is not a license to skip RED requirements, tests, independent
review, owner authorization, existing spend caps or unknown runtime effects.
