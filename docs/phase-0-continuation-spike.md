# Phase 0 — Continuation spike protocol

The spike answers one question before any durable machine is built:

> Can our plugin turn OpenCode `steps` exhaustion into a recoverable pause,
> without resetting authority, budget, fencing, or permissions, and without
> using continuation to evade a permission denial?

Two layers of evidence are required:

1. **Deterministic core** — `src/execution/` with fault-injection tests
   (`npm test`). These prove the state machine invariants: CAS, fencing,
   idempotency, crash recovery, budget monotonicity, no duplicate dispatch, and
   hard-stop-on-denial.
2. **Empirical OpenCode run** — the `harness_continuation_probe` tool, run inside
   OpenCode with a real model, to measure what persists across a genuine `steps`
   exhaustion boundary.

## Deterministic core (run any time)

```sh
npm test
npm run validate
```

`tests/execution/` covers:

- event-log sequence integrity and durable atomic write;
- state projection conflicts (out-of-order/torn log);
- CAS rejection of a stale `expected_revision`;
- fencing: monotonic generation, zombie-controller denial, same-holder renewal;
- idempotency: replay vs conflict on a reused `operation_id`;
- budget accumulation across a crash and rebuild (never resets);
- dispatch lifecycle and no auto-relaunch on reconciliation;
- candidate hash binding: `PASS(A)` cannot accredit `B`.

## Empirical OpenCode run

Inside an OpenCode project that has the plugin loaded:

1. Call `harness_continuation_probe` with `action: "init"`, a `probe_id`, and the
   real `session_id`. This approves a mandate, activates a JIT WU, reserves and
   launches a dispatch, and records a checkpoint under
   `.harness/execution/probe/<probe_id>/`.
2. Let the agent run until OpenCode's `steps` limit stops it. Do **not** manually
   re-approve anything, and do **not** run any forbidden operation through
   another tool.
3. Continue the same logical execution.
4. Call `harness_continuation_probe` with `action: "verify"`. It reports the
   invariant matrix: stable execution/mandate/WU identity, non-resetting budget,
   no duplicate dispatch, monotonic fencing token, no synthesized approval, and
   no unexpected blocker.

Record: OpenCode version, plugin version, the `steps` values used, the session
identifiers before and after continuation, and the full `verify` JSON.

## Binary verdict

- Every deterministic test passes **and** the empirical `verify` returns
  `invariants.passed === true` **and** a controlled `permission.rejected`
  scenario produces `BLOCKED_PERMISSION` with zero fallback attempts
  → `PHASE_0 = PASS`.

- Any failing invariant, any unproven property, or any observed permission
  widening or forbidden fallback → `PHASE_0 = FAIL`. Do not proceed to Phase 1.

If the empirical continuation mechanism (for example `ctx.session.prompt(...)`)
does not preserve the invariants, we change the scheduling mechanism. The rest
of the architecture in `docs/execution-control-plane.md` is unaffected.
