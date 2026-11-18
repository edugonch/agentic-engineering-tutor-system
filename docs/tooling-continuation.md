# Governed tooling continuation — operational recovery

## Problem

A terminated or never-launched OpenCode worker can be fully accounted for in
the append-only controller journal while an older free-text `BLOCKED_TOOLING`
event remains active. A diagnostic-only supervisor would then stop an otherwise
safe Epic or ten-Work-Unit batch indefinitely. Host uptime alone cannot prove
that the next request will never fail, and must not be a permanent precondition.

## Automatically recoverable subset

The supervisor (or the operator using `recover_settled_tooling`) may record
a **single audited `CLEAR_BLOCKER`** when every condition holds:

- Exact active `BLOCKED_TOOLING` in an owner-approved Epic and live WU;
- At least one `harness-builder` or `harness-reviewer` dispatch from
  the current WU was either `released` **after prepare and before launch claim**
  (a terminal `reservation_status=released`, `released_from_status=pending_launch`,
  no child created), or was durably **fenced and abandoned/reconciled**.
  Both forms require terminal event provenance within 20 revisions of the exact
  blocker. This provenance is projected from the original immutable journal,
  including existing historical events. Merely reserving and cancelling an
  unprepared dispatch, or releasing one long before an unrelated tooling fault,
  never authorizes clearance;
- All dispatches in the execution are `released`, `result_reconciled`,
  or `abandoned_reconciled`; no outstanding identity, active phase,
  verification, external wait or process repair;
- A real runtime observation is available and the *short* builder
  anti-thrashing cooldown is not active;
- Fewer than **three** automated continuations have been recorded for the same WU.

The clearance records `recovery_evidence.kind=SETTLED_DISPATCH_CONTINUATION`,
the exact WU, sorted dispatch IDs and attempt number, and targets the exact
blocker revision. The state projector **revalidates** all deterministic
conditions during CAS commit and historical replay. No free-form diagnosis
provides authority; no historical journal is rewritten.

This is **permission for one more attempt**, not a declaration that a server,
DNS or provider was permanently repaired. Three recurrent interruptions in
the same WU cannot cause unbounded autonomous retry spend.

## Fail-closed boundaries

No auto-clear is allowed for a live/ambiguous child, a pending or claimed
launch, an unsettled dispatch, an active verification/setup, a pending external
wait, an unfinished process repair, an unrelated or historical dispatch, an
explicit failed setup/verification check, an authority/security/scope blocker,
a missing runtime observation, or an active anti-thrashing cooldown.

The standard reviewer PASS, frozen check receipts, TDD order, candidate hash,
PR head/base/tree verification and single governed merge remain unchanged.
The existing ten-WU batch is preserved; the supervisor must never create a
replacement Epic or batch to recover a worker interruption.

## Observable diagnosis

`harness_execution_controller(action="operational_status")` includes
`tooling_continuation` with an `eligible` flag and stable machine reason:
`UNSETTLED_DISPATCH`, `NO_RECENT_SETTLED_INTERRUPTION`,
`PHASE_OR_EXTERNAL_EFFECT_UNSETTLED`, `RUNTIME_COOLDOWN_ACTIVE`,
`RETRY_CAP_REACHED`, `NOT_A_SETTLED_LAUNCH_INCIDENT`, etc.

The explicit `recover_settled_tooling` action is an audited fallback when the
automatic supervisor cannot run (for example, the bound root session did not
finish successfully). When ineligible it is read-only, reports its exact reason
and **does not** mutate the blocker.

Do not indiscriminately clear all `BLOCKED_TOOLING` events. A setup failure or
unknown in-flight side effect is not the same as a fully settled interruption.

## Regression coverage

The ten-WU E05-28…E05-37 fixture checks real batch identity retention,
terminal dispatch receipts, audit count and exact replay identity. Negative
cases include live/ambiguous children, stale receipts, active verification or
external waits, an active orphan cooldown, incorrect evidence, failed setup,
a different WU, real security blockers, and the three-attempt hard cap.
The supervisor integration checks resumption of the same WU without
new authority or duplicate queued continuation.
