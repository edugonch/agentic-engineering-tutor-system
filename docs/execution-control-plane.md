# Execution Control Plane — Phase 0 contract

This document is the authoritative semantics contract for the Phase 0 spike. It
codifies the decisions that Workshop Waitlist forced: separating human approval
from operational authorization, making the reviewer able to verify, and turning
`steps` into a recoverable pause instead of a business boundary. The phase is
**binary**: every invariant below must be demonstrated, or Phase 0 is `FAIL`.

Implementation lives in `src/execution/`; the probe is exposed as
`harness_continuation_probe`.

## 1. Authority model

Two questions must never collapse into one field:

| Question | Answered by | Values |
|---|---|---|
| Who approved this document/artifact? | knowledge artifact `status` | `PROPOSED` / `DRAFT` / `APPROVED` |
| Does the controller have authority to run this transition? | execution `authorization` | `AUTHORIZED_BY_MANDATE` / `OWNER_DIRECTED` |

- `APPROVED` is reserved for human/owner approval. The controller never invents it.
- A JIT WU is an artifact with `status: PROPOSED`, `origin: DERIVED`, and
  execution `authorization: AUTHORIZED_BY_MANDATE`. These are not contradictory.
- The initial mandate (`MANDATE_APPROVE`) is the human authority input that
  pins the Epic outcome, WU ceiling, and budget. Those scope/budget fields remain
  immutable for the execution.
- `MANDATE_AMEND` is a narrow, versioned compatibility transition. It may update
  only `merge_policy` and `required_ci_checks` from a new **APPROVED Epic
  artifact** while keeping the same execution, mandate identity, WU ceiling,
  budget ledger, dispatches, candidates, reviews, PR/CI bindings, and history.
  The original authority event remains in `events.ndjson`; the amendment is a
  new auditable event, never an overwrite.

## 2. Durability target

- **v1 guarantee:** survive process crash, OpenCode restart, and an orderly
  machine reboot.
- **Power loss:** best effort; not yet guaranteed.
- A write is committed only after the file bytes are fsynced and the parent
  directory entry is fsynced (`src/execution/fsync.js`).
- We never claim a stronger guarantee than the one implemented.

## 3. State model

`events.ndjson` is the **only** canonical state. `state` is always a projection
rebuilt by replaying the log; there is no cached state file that can diverge.

Each event carries:

```text
sequence            monotonically increasing from 1
event_id            unique
operation_id        logical operation identity
operation_type      typed verb (see OPERATION_TYPES)
operation_hash      canonical hash of the operation body
body                operation payload
previous_revision   revision this event builds on
next_revision       revision this event produces (= previous + 1)
fencing_token       lease generation under which it committed
timestamp           wall-clock time
```

Projection validates, on every read, that `previous_revision` chains and
`next_revision` is sequential. A torn or out-of-order log is a hard error, not a
silent repair.

## 4. Compare-and-swap + fencing

- Every commit requires the `expected_revision` the caller read from `snapshot()`
  to equal the current projected revision. A lost update is rejected.
- The fencing token is an **integer generation**, assigned while holding the
  execution mutex. It is never derived from wall-clock time.
- A same-holder lease renewal keeps its token; any transfer of ownership
  (absent, expired, different holder) increments the generation.
- A suspended controller that wakes after its lease expired and another holder
  advanced state fails both the fencing check and the revision CAS.

## 5. Idempotency

Reusing an `operation_id`:

```text
same operation_id + same operation_hash  → replay the previous result
same operation_id + different operation_hash → conflict (reject)
```

Duplicates are never silently ignored; a conflict is a loud error.

## 6. Dispatch

A dispatch is one concrete external execution attempt:

```text
reserved → pending_launch → launched → finished
```

- `operation_id` identifies the logical transition; `dispatch_id` identifies the
  concrete attempt; `session_id` is attached at launch.
- The window between session creation and `session_id` persistence is an
  **ambiguous-launch** hazard. Recovery therefore reconciles before relaunching:
  `reconcileDispatch` reports status and a conservative `UNRESOLVED`/`COMPLETED`
  verdict and **never** auto-relaunches.

## 7. Budget

- The controller measures wall clock. It never trusts model-reported elapsed time.
- Only `ACTIVE` phases bill; `WAITING_OWNER`, `WAITING_EXTERNAL`, and `PAUSED` do not.
- Budget is `total_seconds` (fixed at mandate) and `used_seconds` (accumulated).
- Continuation must never reset `used_seconds`; a rebuild from events must yield
  the same accumulated value.

## 8. Candidate identity

A candidate is pinned by two independent hashes:

```text
manifest_hash  identifies the candidate description (base HEAD, paths, deletions,
               authorized untracked files, modes, symlinks)
tree_hash      identifies the material tree reconstructed from the manifest
```

`RECORD_REVIEW` binds a verdict to one exact candidate's hashes. A one-line
repair produces a new candidate, and `PASS(A)` can never accredit `B`.

## 9. Blockers and hard stops

Recoverable blockers (`BLOCKED_TOOLING`, `BLOCKED_EXTERNAL_FACT`,
`BLOCKED_ARCHITECTURE`) may be resolved only by `CLEAR_BLOCKER`, bound to the
exact blocker class + blocker revision and carrying a non-empty resolution.
Terminal blockers cannot use this transition. Merge and WU closure require no
unresolved blocker.

`permission.rejected` is a **global invariant**:

```text
permission rejected → BLOCKED_PERMISSION
                     no additional dispatch
                     no alternative tool/channel for the rejected operation
                     budget preserved
                     checkpoint preserved
```

Diagnosing the cause through an independently allowed action is permitted;
achieving the rejected operation by another route is not. The continuation
mechanism must never become a permission-reset path.

## 10. Phase 0 PASS rubric

`PHASE_0 = PASS` only when controlled tests demonstrate, with evidence:

```text
Execution logical ID unchanged
Mandate identity unchanged
Budget: X before, X + delta after continuation (never resets)
steps allowance replenished through a supported continuation mechanism
progress resumes from checkpoint
duplicate dispatch = 0
permission widening = 0
forbidden fallback attempts = 0
state corruption = 0
manual user continuation = 0
```

and a second test introduces `permission.rejected` expecting
`state = BLOCKED_PERMISSION`, additional dispatches = 0, alternative execution
attempts = 0, budget and checkpoint preserved. Any failure or unproven property
is `PHASE_0 = FAIL`.

## Multiple WUs and recovery of existing integrations

Bindings and merge receipts are indexed by candidate (`pr_bindings`, `merges`);
`pr_binding` and `merge` remain the selected integration for compatibility.
Selecting a fresh PASS-reviewed candidate preserves the earlier binding/merge.
A successor may be selected after its predecessor WU completed and any merge was
verified. A replacement within the same WU is allowed only before a merge starts.
An in-progress merge cannot be discarded by binding another candidate.

The indexes rebuild by replaying existing events, including logs with the old
execution-wide merge operation IDs. No log rewrite, reset, unbind command, or
manual state-file edit is needed. New merge operations include candidate identity.
CI observations are scoped to candidate/check and may advance from PENDING to
SUCCESS (or a new run); only the latest identical observation is replayed. Blocker
retries replay within the active episode; clearing one permits a new episode,
including the same reason. An active blocker cannot be replaced or downgraded.

For an existing execution stuck at the second PR:

1. Install the corrected plugin revision through the normal plugin installer or,
   once merged into the configured branch, the normal plugin update workflow.
   Reload/restart the OpenCode server so the new code is actually loaded.
2. Run controller `status` and `verify`. Confirm the existing execution, active WU,
   recorded candidate/PASS review, previous verified merge, and external PR/head.
3. If a recoverable tooling blocker is active, clear it with evidence that the
   corrected plugin is loaded. Never clear terminal blockers or change policy.
4. Retry `bind_pr` for the existing new candidate and exact PR/head/base. Record
   its actual CI evidence, use the mandate's merge/verification tool, then
   `complete_wu`. Continue only through the approved WU sequence.

Do not recreate the WU, candidate, or PR just to bypass stale integration state.
The regression fixture covers a completed predecessor and an already activated
successor with legacy operation IDs, asserting the event-log prefix is unchanged.
It does not claim access to a user's live OpenCode process or repository state.

### Repeated tooling failures

The controller and both merge tools now use a per-session runtime failure guard.
Two identical errors for identical tool input are allowed for diagnosis; a third
attempt raises `HARNESS_NO_PROGRESS`. Status reads, checkpoints, and blocker
recording remain available and do not erase the failure count. A successful
non-audit durable mutation, successful merge, or new user turn resets it.
This guard is ephemeral and cannot interrupt reasoning within a provider request,
recognize every equivalent paraphrase, or implement the full Epic continuation
loop. The orchestrator template requires prompt blocker/checkpoint recording
without asking permission already granted by the mandate. Existing customized
or project-local agent profiles are not overwritten by this runtime correction;
compare them with the packaged template when updating those profiles.
