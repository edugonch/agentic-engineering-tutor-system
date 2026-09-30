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

## Phase 0 empirical results (2026-09-29)

Revisions tested (branch `phase-0-execution-core`): `6b63d4c` → `a1a68db`
(default-enabled driver) → `4c833826` (event diagnostics) → `4ca1d7b4` (real
event shape fix). Runtime: OpenCode v2.0.18, model `opencode/gpt-6.1-sol`.

### Real event stream shape (empirically captured)

The plugin event stream is **not** `{ type, properties }`. It is:

```text
{ id, created, type, location, data }
```

- `sessionID` lives at `data.sessionID` (resolved by a recursive `^ses_` search).
- Turn completion is **`session.execution.succeeded`**, not `session.idle`.
- Full session lifecycle: `session.execution.started` → `session.step.started` →
  `session.tool.*` / `session.reasoning.*` / `session.text.*` →
  `session.step.ended` → `session.execution.succeeded`.

Both initial guesses (event type `session.idle`; sessionID in `properties`)
were wrong and were corrected empirically in `4ca1d7b4`.

### C — continuation: core mechanism CONFIRMED

Using a `steps: 2` probe agent (`harness-phase0-probe`) driven through the API:

- `stepCount` went 2 → **4** across the continuation, proving `ctx.session.prompt`
  resets `steps` (the central hypothesis).
- `continuationsUsed` went 0 → **1** and then stopped (`max_continuations: 1`).
- The driver's continuation prompt appeared in the session as a `user` message
  with no human in the loop → **`human_prompt_required = 0`**.
- No subscription errors; the `context` hook counted the probe's steps correctly.

### D — blocker: core mechanism CONFIRMED

A probe marked blocked (`harness_continuation_spike block`) exhausted its 2
steps, ended its turn with `session.execution.succeeded`, and the driver did
**not** continue (`continuationsUsed: 0`).

### Status

The **central hypothesis is empirically confirmed**: the plugin can turn `steps`
exhaustion into a recoverable pause, continue autonomously via
`ctx.session.prompt`, and stop at a blocker. Still to verify before a full PASS:

- **Turn-guard-not-reset** and **permission-preserved** across the continuation
  are code-enforced (`isInternalPrompt` marker) and unit-tested, but not yet
  observed end-to-end in the runtime.
- **Real `permission.rejected` → durable `BLOCKED_PERMISSION`** auto-wiring is
  Phase 3/4 work; the D spike used the explicit `block` action as a stand-in.

`PHASE_0 = UNVERIFIED` on the full rubric; the continuation hypothesis is proven.

