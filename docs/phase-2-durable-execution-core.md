# Phase 2 — Durable Execution Core

> Status: **DESIGN LOCKED — pending implementation**. Baseline `main` at
> `e52b5f391df6b54c747977608dcd501b3d99efc0` (Phase 0 = PASS, Phase 1 = PASS,
> verified post-merge). No implementation is changed yet; this document freezes
> the target contract and the minimum delta before any code is modified.
>
> Three design decisions are **resolved** (see §12): (1) a separate
> `reserved_seconds` ledger; (2) a dedicated `DISPATCH_MARK_AMBIGUOUS`
> operation; (3) a new `harness_execution_controller` runtime tool.

## 1. Objective

Turn the Phase 0/1 primitives (atomic events, CAS, lease/fencing, idempotency,
budget, candidate/verification) into a **recoverable execution machine**: a
controller that accepts an authorized transition, persists it atomically as a
durable event, dispatches external work, survives interruption/restart, and
reconciles existing results — without duplicating execution or losing authority,
budget, or fencing.

The conceptual pipeline the machine implements:

```text
command / transition intent
        ↓
authority + expected_revision + lease/fencing
        ↓
durable event commit (events.ndjson, fsynced)
        ↓
recoverable state projection (replayed from the log, never cached-trusted)
        ↓
dispatch intent (reserve → prepare → launch)
        ↓
external execution (session/process)
        ↓
result reconciliation (finish → reconcile → RESULT_RECONCILED)
```

The machine must survive: restart, crash between operations, retries, duplicate
operation IDs, stale controllers, stale revisions, ambiguous dispatch, and full
reconstruction from the event log.

## 2. Existing primitives — audit against Phase 2

This section is the result of the mandatory pre-implementation inspection. Each
mechanism is classified: **DONE** (proven, do not reimplement), **ISOLATED**
(exists but not wired into the recovery machine), or **MISSING** (must build).

| # | Mechanism | Location | Status | Notes |
|---|---|---|---|---|
| 1 | Event log = single commit point | `event-log.js` | DONE | `events.ndjson`, atomic + `fsync` on file and dir |
| 2 | Recoverable state projection | `state.js` | DONE | `project(events)`; sequence/revision chaining validated; torn log = hard error |
| 3 | Compare-and-swap (`expected_revision`) | `execution.js` | DONE | stale revision rejected on every commit |
| 4 | Lease + monotonic fencing token | `lease.js` | DONE | integer generation; transfer increments; same-holder renewal keeps |
| 5 | Idempotency (replay vs conflict) | `execution.js` | DONE | `operation_id` + `operation_hash` |
| 6 | Atomic structured transitions | `execution.js` | DONE | event built, projected, written under mutex |
| 7 | Terminal blocker hard-stop | `state.js` | DONE | `FORWARD_EXECUTION_TYPES` rejected after terminal blocker |
| 8 | Budget monotonic (never resets) | `state.js` | DONE | wall-clock phase billing; replay gives same accumulation |
| 9 | Candidate/verification substrate | `candidate*.js`, `verification*.js`, `readiness.js` | DONE | Phase 1, unchanged |
| 10 | Controller API | `execution.js` | PARTIAL | `snapshot`/`acquire`/`commit`/`reconcileDispatch` exist; `reconcileDispatch` is read-only (see #11) |
| 11 | Durable dispatch lifecycle | `constants.js`, `state.js` | MISSING | only 4 statuses; no `RESULT_RECONCILED`, no `AMBIGUOUS` |
| 12 | Dispatch reconciliation (durable) | `execution.js` | ISOLATED | `reconcileDispatch` reports a verdict but never persists it, never reaches `RESULT_RECONCILED`, cannot classify `AMBIGUOUS` |
| 13 | Recovery entry point | — | MISSING | no `recover()` that classifies every dispatch on restart into the 4 recovery cases |
| 14 | Budget reservation (per dispatch) | — | MISSING | budget only bills phases; no durable reservation that is crash-safe against double-reserve |
| 15 | Explicit fencing-token input on commit | `execution.js` | PARTIAL | fencing is enforced via `holder_session_id` match; a same-holder token is not passed/checked |

### 2.1 What is already satisfied by construction (do not build)

- **`state.json` missing/corrupted → rebuilt from log.** There is no cached
  `state.json`; every read replays `events.ndjson`. The invariant is therefore
  stronger than "cache plus rebuild": a divergent cached projection cannot
  exist. A corrupted foreign `state.json` dropped into the exec dir is ignored
  because nothing reads it. We will demonstrate this with a test, not with new
  caching code.
- **Crash after event commit → projection rebuild succeeds.** Covered by the
  existing budget-rebuild test and the projection replay path.
- **Budget never resets across continuation/restart.** Proven in Phase 0.
- **`permission.rejected` fail-closed; no alternative route.** Proven in Phase 0
  (structural, not prompt-based).

### 2.2 What must actually change (minimum delta)

The delta below is the smallest change that upgrades the machine from "isolated
primitives + a commit path" to "recoverable execution controller". It does **not**
touch candidate/reviewer/readiness, does not add WU/JIT derivation, and does not
change any Phase 0/1 semantics.

## 3. Invariants (non-negotiable)

1. **Single source of truth** — `events.ndjson` is canonical. `state` and any
   other view are projections, always replayed, never trusted from cache.
2. **Atomic commit** — a transition is confirmed only when its durable event is
   persisted (file fsync + directory fsync) under the execution mutex, with a
   matching `expected_revision` and a valid lease.
3. **Compare-and-swap** — every mutation carries `expected_revision`; a lost
   update is rejected, not merged.
4. **Fencing** — the lease holds a monotonic integer generation. A stale
   fencing token (wrong holder, or same holder with a superseded generation)
   can never advance state.
5. **Idempotency** — `same operation_id + same content → deterministic replay`;
   `same operation_id + different content → conflict`. A conflict is a loud
   error, never a silent overwrite.
6. **Authority** — `APPROVED` is human approval only; the controller never
   synthesizes it. `AUTHORIZED_BY_MANDATE` is separate operational authority.
   Prose never grants authority.
7. **Budget monotonic** — `used_seconds` and `reserved_seconds` never reset and
   never decrease across continuation/restart; a crash between reserve and
   execution must not double-reserve.
8. **No exactly-once claim** — OpenCode does not guarantee exactly-once
   external execution. The machine guarantees at-most-once *dispatch identity*
   persistence and reconcile-before-relaunch.
9. **Hard stops** — `permission.rejected` → `BLOCKED_PERMISSION`, no further
   forward execution, no evasive route, budget/checkpoint preserved.
10. **Controller is stateless** — the controller never relies on conversational
    memory to reconstruct state; everything needed lives in `.harness/execution/`.

## 4. State and dispatch lifecycle

### 4.1 State projection shape

Already defined in `state.js` (`initialState()`). Phase 2 extends only the
budget and dispatch sub-shapes. The existing `used_seconds` field is the
*consumed* ledger (the user-facing term `consumed_seconds` maps onto it — no
rename, to avoid a Phase 0/1 regression):

```text
budget: {
  total_seconds,
  used_seconds,       // consumed ledger (existing field, semantics unchanged)
  reserved_seconds,   // NEW: derived projection = Σ reserved_seconds of live reservations
  active_phase,
  active_started_at,
}

dispatches[dispatch_id]: {
  status,              // dispatch lifecycle (see 4.2)
  session_id,          // process/session identity, null until LAUNCHED
  operation_id,        // logical transition that produced this dispatch
  reserved_seconds,    // budget slice reserved at RESERVED
  reservation_status,  // RESERVED | RELEASED | CONSUMED
  actual_consumption,  // real cost recorded at reconcile (null until settled)
  result,              // attached at FINISHED
  reconciled,          // { verdict, evidence, at_revision } once reconciled
}
```

The budget reservation belongs to the **dispatch**, not to the phase. The
aggregate `budget.reserved_seconds` is a **derived projection of the event log**
— it is never an independent source of authority, and it is maintained only by
the projection function (`applyEvent`) from dispatch events. Available budget
is always computed as:

```text
available = total_seconds - used_seconds - reserved_seconds
```

### 4.2 Dispatch lifecycle

`dispatch_id` is the concrete execution attempt, distinct from `operation_id`
(the logical transition). The lifecycle gains two statuses over Phase 0, plus a
reservation sub-state (`reservation_status`):

```text
RESERVED ──prepare──▶ PENDING_LAUNCH ──launch(session_id)──▶ LAUNCHED
    │                        │                                   │
    │                        └──mark_ambiguous──▶ AMBIGUOUS       │
    │                                                            │
    └──────────────────────────────────────────────────▶ AMBIGUOUS
    │                                                            │
    └──release──▶ RELEASED (provably never launched)             │
                                                                 │
                                                   finish(result) ▼
                                                         FINISHED
                                                             │
                                                     reconcile ▼
                                                    RESULT_RECONCILED
```

- `RESERVED` — budget slice reserved; nothing launched.
- `PENDING_LAUNCH` — launch prepared; session/process identity not yet known.
- `LAUNCHED` — external execution started and its identity is persisted.
- `FINISHED` — external execution reported a result; result attached, not yet
  reconciled into durable state.
- `RESULT_RECONCILED` — result incorporated; terminal for the dispatch.
- `RELEASED` — the reservation was explicitly released because recovery proved
  the dispatch was never launched. Terminal; no result, no consumption.
- `AMBIGUOUS` — launch identity is uncertain (crash after external launch but
  before `session_id` persisted). Recovery must **not** relaunch, and must
  **not** release the reservation; it must surface the ambiguity for
  investigation.

Reservation sub-state (`reservation_status`) is independent of dispatch status:

```text
RESERVED  — budget slice is held (set at DISPATCH_RESERVE)
RELEASED  — held slice returned (DISPATCH_RELEASE, never-launched only)
CONSUMED   — held slice converted to consumption (DISPATCH_RECONCILE)
```

`DISPATCH_RECONCILE` (existing operation) is repurposed from "advisory, never
changes status" to "records reconciliation evidence, moves the reservation to
`CONSUMED`, and — when the dispatch is `FINISHED` — transitions it to
`RESULT_RECONCILED`". At reconcile:

```text
reserved_seconds   -= reservation
used_seconds       += actual_consumption   (defaults to reservation when unknown)
```

Unknown consumption is never rewritten to zero: if `actual_consumption` is not
reported, the reservation is conservatively treated as fully consumed.

### 4.3 Recovery classification

On restart, a `recover()` entry point scans `dispatches` and classifies each
into exactly one of the four cases, returning a structured plan and **never**
auto-launching:

```text
reserved / pending_launch, no launch event   → "not launched"     (safe to prepare/launch, or release)
launched with session_id                     → "launched, identifiable" (reconcile by identity)
finished, not reconciled                     → "finished, unreconciled" (incorporate result, no re-exec)
ambiguous (marked)                           → "launch identity ambiguous" (do NOT relaunch, do NOT release)
```

## 5. Recovery semantics

- Recovery is **reconstruction + classification**, never implicit mutation.
- A dispatch in `FINISHED` is re-incorporated into durable state exactly once
  via `DISPATCH_RECONCILE` (idempotent by `operation_id`), and never re-executed.
- A dispatch in `AMBIGUOUS` is never auto-relaunched **and its reservation is
  not released** — the budget slice stays held until the ambiguity is resolved,
  because "unknown" must never be rewritten to "zero".
- A dispatch provably never launched (`RESERVED`/`PENDING_LAUNCH` with no launch
  event) may be released via a durable `DISPATCH_RELEASE` transition, returning
  its reservation to `available` with zero consumption.
- Unknown consumption is never rewritten to zero: if a launch happened but its
  outcome is unknown, the dispatch stays `LAUNCHED`/`AMBIGUOUS` with its
  reservation intact until reconciled.

## 6. Commit point

The single commit point is `execution.js commit()` writing the appended
`events.ndjson` under the mutex. Phase 2 does not add a second commit point; it
adds the *recovery* and *reconciliation* operations that read that point. The
advisory `lease.state_revision` write remains advisory (never trusted).

## 7. Idempotency

Unchanged from Phase 0, but now extended to reservation and reconciliation:

- `DISPATCH_RESERVE` with a repeated `operation_id` and identical body
  (including `reserved_seconds`) → replay, no second reservation. This is the
  crash-safe no-double-reserve guarantee.
- `DISPATCH_RESERVE` with a repeated `operation_id` but a different
  `reserved_seconds` (or other body) → conflict (different `operation_hash`).
- `DISPATCH_RECONCILE` with a repeated `operation_id` → replay of the same
  reconciliation (the `FINISHED → RESULT_RECONCILED` transition and the
  `reserved → used` settlement are applied exactly once).
- `DISPATCH_RELEASE` and `DISPATCH_MARK_AMBIGUOUS` are likewise idempotent by
  `operation_id`; a replayed release cannot double-return a reservation.

## 8. Fencing

- `lease.fencing_token` is a monotonic integer generation (unchanged).
- NEW: `commit` accepts an optional `lease_fencing_token`; when provided it must
  equal the current lease token, else the commit is rejected even if the holder
  matches. This closes the "same holder re-acquired the lease (token 1→2) but an
  old in-flight request from token 1 wakes" gap. Holder mismatch remains the
  primary cross-controller guard.

## 9. Fault model

The machine is designed against these faults (each maps to a fault-injection
test, see §11):

| Fault | Expected behavior |
|---|---|
| Crash after event append, before projection regen | restart replays log → correct state |
| Crash after budget reserve, before dispatch | reservation durable; retry replays (no double reserve) |
| Duplicate `operation_id` (same content) | deterministic replay |
| Conflicting reuse of `operation_id` | conflict error |
| Two controllers at same revision | only the valid fencing holder advances (CAS + fencing) |
| Expired lease + new fencing + zombie controller | zombie denied (fencing/revision) |
| Crash before launch | `RESERVED`/`PENDING_LAUNCH` recovered, safe to launch |
| Crash immediately after launch | `LAUNCHED` with identity (or `AMBIGUOUS` if identity not yet persisted) |
| Ambiguous external execution identity | `AMBIGUOUS`, no duplicate launch |
| Finished execution awaiting reconciliation | `FINISHED` → reconcile → `RESULT_RECONCILED`, no re-exec |
| Provably never-launched dispatch | `RESERVED`/`PENDING_LAUNCH` → `RELEASE` returns the slice, zero consumption |
| Ambiguous launch holds its reservation | `AMBIGUOUS` keeps `reservation_status: RESERVED` until resolved |
| Corrupted/deleted projection (`state.json`) | ignored; rebuilt from log |
| Restart | authority, budget, dispatch state preserved |
| Terminal blocker | forward transitions rejected |
| `permission.rejected` | fail-closed, durable `BLOCKED_PERMISSION` |
| Continuation | execution budget not reset |

Durability target remains v1: survive process crash, OpenCode restart, orderly
machine reboot. Power loss is best effort. We never claim stronger.

## 10. Exit conditions (Phase 2 acceptance)

`PHASE_2 = PASS` requires **all** of:

```text
crash after event commit              → projection rebuild succeeds
crash before dispatch launch          → pending intent recovered
crash after launch, before identity   → AMBIGUOUS, no duplicate launch
same operation_id twice               → deterministic replay
same operation_id different payload   → conflict
two controllers same revision         → only valid fencing holder advances
stale controller wakes later          → rejected
state.json missing/corrupted          → rebuilt entirely from event log
restart                               → authority, budget, dispatch preserved
event committed, projection unwritten → restart reconstructs correct state
budget reserved, crash before exec    → no silent double reserve
dispatch finished, crash before reconcil→ recovery incorporates result, no re-exec
```

plus a **real OpenCode runtime E2E** demonstrating recovery/reconciliation over
the actual runtime with at least one real interruption/restart between durable
states. Unit tests alone are insufficient.

## 11. Minimum implementation delta

Ordered, each step followed by its unit test + fault injection + `npm run
validate` before the next step (no batching to the end):

1. **`constants.js`** — add `DISPATCH_STATUS.AMBIGUOUS`,
   `DISPATCH_STATUS.RESULT_RECONCILED`, `DISPATCH_STATUS.RELEASED`; add
   `RESERVATION_STATUS = { RESERVED, RELEASED, CONSUMED }`; add operation types
   `DISPATCH_MARK_AMBIGUOUS` and `DISPATCH_RELEASE`. (`DISPATCH_RECONCILE`
   already exists.)
2. **`state.js`** — add `budget.reserved_seconds` (derived by projection only);
   add per-dispatch `reserved_seconds`, `reservation_status`,
   `actual_consumption`; implement the transitions:
   - `DISPATCH_RESERVE` also sets `reserved_seconds` + `reservation_status:
     RESERVED` and increments `budget.reserved_seconds`;
   - `DISPATCH_RELEASE` (`RESERVED`/`PENDING_LAUNCH`, never launched) →
     `RELEASED`, `reservation_status: RELEASED`, return the slice;
   - `DISPATCH_MARK_AMBIGUOUS` (`RESERVED`/`PENDING_LAUNCH`) → `AMBIGUOUS`
     (reservation stays held);
   - `DISPATCH_RECONCILE` (`FINISHED`) → `RESULT_RECONCILED`,
     `reservation_status: CONSUMED`, `reserved_seconds -= reservation`,
     `used_seconds += actual_consumption (?? reservation)`;
   - `AMBIGUOUS`/`RESULT_RECONCILED`/`RELEASED` are absorbing (no further
     transition; forward-execution guard also treats `AMBIGUOUS` correctly).
3. **`execution.js`** — add explicit `lease_fencing_token` check in `commit`;
   add `recover()` (read-only classification plan per §4.3) and
   `reconcileAll()` (idempotently reconciles every `FINISHED` dispatch; never
   auto-launches; never touches `AMBIGUOUS`); add a `releaseDispatch()`
   convenience wrapper for provably-never-launched dispatches.
4. **Runtime instrument** — a new tool `harness_execution_controller` exposing
   `init / reserve / launch / finish / recover / reconcile / release / verify`
   against an isolated `.harness/execution/` directory, so the real OpenCode
   runtime E2E can be driven across a genuine interruption. Never touches
   config, permissions, or agents; never simulates the model. The Phase 0
   `harness_continuation_probe` stays frozen.
5. **Fault-injection suite** — one test per §9 row, including reservation
   release (provably-never-launched) and ambiguous-holds-reservation cases.

Explicitly **out of scope** (later phases): JIT WU derivation, autonomous Epic
loop, general blocker resolver, multiple repair cycles, merge/deploy/release,
full Epic Mandate semantics beyond what the core needs, new reviewer
capabilities, and any change to Phases 0–1 without a demonstrated regression.

## 12. Resolved design decisions

1. **Budget reservation → separate `reserved_seconds` ledger.** The reservation
   belongs to the dispatch (`dispatch_id` + `operation_id` + `reserved_seconds`
   + `reservation_status`); the aggregate `budget.reserved_seconds` is a
   **derived projection of the event log**, not an independent authority.
   Formula: `available = total_seconds - used_seconds - reserved_seconds`.
   No pseudo-reserved phase (keeps accounting, phase, and dispatch lifecycle
   separate).
2. **`AMBIGUOUS` entry → dedicated `DISPATCH_MARK_AMBIGUOUS` operation.**
   Keeps `LAUNCHED` meaning "identity known" unambiguous.
3. **Runtime instrument → new `harness_execution_controller` tool.** The
   Phase 0 `harness_continuation_probe` stays frozen.

## Post-V1 pilot refinement — evidence-backed ambiguous launch identity recovery

A real LLM Learning pilot exposed one missing recovery transition: an external
OpenCode session had been created successfully, the durable dispatch had already
been conservatively marked `AMBIGUOUS`, and subsequent investigation established
the exact external session identity. The original Phase 2 machine correctly
forbade relaunch and release, but provided no governed way to record the newly
known identity.

The refinement is deliberately narrower than Phase-4 autonomous recovery:

- `recover()` remains read-only classification.
- `DISPATCH_LAUNCH` still accepts only the normal pre-launch states and never
  accepts `AMBIGUOUS`.
- `DISPATCH_RESOLVE_AMBIGUOUS_LAUNCH` is the only
  `AMBIGUOUS → LAUNCHED` transition.
- It requires an explicit non-empty external `session_id` and
  `resolution_evidence`.
- It records an already-happened external side effect; it performs no launch.
- The existing reservation remains `RESERVED`; `used_seconds` and
  `reserved_seconds` do not change.
- The transition uses the ordinary append-only event log, operation identity,
  CAS revision, lease, and fencing-token path.
- A retry of the same operation is idempotent; conflicting evidence/session
  payload under the same operation identity is rejected.
- After resolution, ordinary `FINISH → RECONCILE` semantics apply.

This does not reintroduce Phase-4 repair loops, blocker authority reset,
`transfer_controller`, automatic session discovery, automatic relaunch, or
automatic release. Without exact externally established identity, an
`AMBIGUOUS` dispatch remains stopped for investigation.

