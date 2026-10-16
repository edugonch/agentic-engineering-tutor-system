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
  An explicit `governed_auto` mandate with `required_ci_checks: []` disables
  CI checks and waits without fabricating CI PASS or changing independent review.
  Matching obsolete CI waits are retired by the approved amendment, with
  immutable event-log provenance; unrelated waits or blockers remain intact.
  The original authority event remains in `events.ndjson`; the amendment is a
  new auditable event, never an overwrite.

### Mandate-derived autonomy and authority preflight

The diagnostic `inspect_next_wu_contract` uses the **same JIT compiler**
as `derive_and_stage_next_wu_contract` when the selected source is a planning
DRAFT/PROPOSED artifact. A DRAFT lacking `active_seconds` does not by itself
require owner budget approval: `READY_FOR_JIT` means the approved Epic
can supply an estimated allocation while retaining its hard total.
`TIME_POLICY_REQUIRED`, `SOURCE_CONTRACT_INCOMPLETE`,
`TECHNICAL_VERIFICATION_MISSING` and `EPIC_BUDGET_EXHAUSTED` are
distinct results. The preflight is read-only and cannot approve an artifact.

An active-WU `BLOCKED_AUTHORITY` for unapproved Appointment state
semantics is **not** the same as a preactivation technical JIT blocker.
Use `inspect_authority_gap` to classify the durable stop without clearing it.
A DESIGN_ONLY WU may produce a source-linked **proposed** state/event/actor
matrix, but cannot assert missing guest auto-confirm or cancellation business
policies as owner-approved. The owner is asked only for exact genuinely
unresolved policy choices; reusable approved decisions do not require
reapproval.

OpenCode may preserve user-owned global agent profiles with older
instructions. The plugin also injects this narrow, safety-preserving
autonomy protocol at the actual root orchestrator context boundary.
Agent readiness reports the effective `plugin_revision`; confirm that
the loaded runtime, not just the remote source, contains these actions.
A failed whole-project verification gate remains FAIL until verified,
regardless of a scoped candidate-only PASS or known pre-existing local
formatting defects. No automatic skip of CI/review/merge is introduced.

### Frozen successor preactivation recovery

If an owner-approved Epic has completed its current WU but is blocked on
`BLOCKED_AUTHORITY` before the next frozen WU can activate, **do not** call
`bind_wu_contract` (active-WU only), clear the authority blocker generically,
edit `events.ndjson`, or reactivate a completed predecessor.

Use this governed sequence:

1. Read `harness_execution_controller(status)` and `verify` for the existing
   execution, including the exact `revision`, `blocker.at_revision`, mandate,
   and next `wu_sequence` entry. Optionally call read-only
   `inspect_next_wu_contract` for a source selection/normalization diagnosis:
   it cannot approve, activate or mutate a WU.
2. Find the approved, fully executable successor WU artifact in the knowledge
   index. The source must link to the approved Epic, pass content-hash checks,
   and contain its exact `execution_contract` with verification commands.
3. Call `stage_wu_contract` with the **next frozen** `wu_id`, exact
   `wu_artifact_id` (prefer its record key), and `expected_revision`.
   This commits an append-only `WU_CONTRACT_STAGE` event. The original authority
   blocker stays active; no WU or dispatch becomes active.
4. Apply the previously approved decision using
   `resolve_authority_blocker(decision_artifact_id)`. Its execution, mandate,
   next WU and blocked-at revision must match. The resulting authority receipt
   includes the staged contract hash.
5. Call `activate_wu` for precisely that WU and staged source. Activation
   consumes the staged contract, rejects drift/reordering, and continues using
   existing verification/review/merge policy.

This repair does not manufacture approval. A DRAFT with incomplete acceptance,
budget, or verification metadata must first obtain an executable normalized
source through the project's existing authorized JIT normalization/approval
procedure. The original DRAFT and frozen sequence remain intact. Apply this
per WU; never promote the entire future backlog as a batch.

### Mandate-derived next-WU technical normalization

A predeclared WU with a DRAFT or PROPOSED document may have enough approved
outcome/scope context but lack machine-readable `execution_contract`.
Under an owner-approved **frozen** Epic with `WU_PLANNING_ESTIMATES`,
`derive_and_stage_next_wu_contract` is a separate technical route from
`stage_wu_contract` (which still requires an individually APPROVED source).

This route:

1. Reads and SHA-verifies the **exact indexed next frozen WU**. It must retain
   preexisting acceptance and expected write-scope statements; a planning label
   alone is not sufficient authority.
2. Derives a positive planning estimate from remaining Epic time divided by
   remaining frozen WUs, never increasing the Epic total. A WU estimate is not a
   new entitlement or hard runtime deadline.
3. Selects only the repository's *existing* safe baseline npm verification
   scripts; if absent it stops. Semantic acceptance remains subject to fresh
   independent review; shell exit status never replaces product acceptance.
4. Stages an immutable source-backed `MANDATE_DERIVED` contract in the
   append-only controller event log. The source archive is unchanged and its
   SHA-256 must match `source_hash`. This is **execution authorized by the
   mandate**, never a fictitious individual owner `APPROVED` artifact.
5. When a matching preactivation `BLOCKED_AUTHORITY` records only missing
   technical contract normalization, the same guarded stage event may record a
   technical resolution with the exact blocker revision. It cannot clear a
   business, security, permission, scope, unrelated, or ambiguous blocker.
6. The orchestrator activates only the staged contract and continues ordinary
   candidate freeze, deterministic verification, independent review, exact-head
   CI and approved merge policy. No bulk future-WU promotion occurs.

The existing APPROVED-source stage/resolution path remains unchanged. The
derived route is intentionally limited to repositories with supported npm
verification scripts; absent tooling must not be concealed with fake checks.

## Durable continuation delivery and no-progress detection

The supervisor separates **queued**, **received**, and **root turn observed** states.
`SUPERVISOR_SENT` alone does not establish that an orchestrator ran. The exact
internal root prompt records `SUPERVISOR_RECEIVED` under the same execution,
session and intent. An independent `session.execution.succeeded` observation
records `SUPERVISOR_TURN_OBSERVED` only when the current supervisor progress
fingerprint has not changed.

A received, completed root turn without progress admits **one** additional
bounded continuation. A second independently observed no-progress turn records
a typed `NO_PROGRESS` stop with the exact intent and fingerprint. The supervisor
never fabricates handoff acceptance, dispatch completion, a new candidate,
review PASS, or a merge. Missing receipt, running/interrupted sessions, security
or authority blockers and unrelated progress do not trigger retries.

Receipt and observation events are append-only and idempotent on the exact
intent ID. Older historical execution logs replay unchanged. Plugin restart
can admit a still-queued continuation using durable identity, rather than
requiring an ephemeral in-memory token. A failed event handler does not
terminate the subscription, and a broken subscription retries with backoff.

This is a conservative liveness bound, not a guarantee that an external
provider will run every queued prompt. Actual root-turn execution and
end-to-end builder-to-merge behavior require a real OpenCode canary.

### Stale-worktree scope reconciliation (fail-closed)

A `BLOCKED_SCOPE` caused by a checkout disagreement is not itself evidence
that the active Work Unit exceeded its approved business scope. New worktree
discrepancies must be triaged as tooling/environment concerns before declaring
functional scope drift. Existing historical `BLOCKED_SCOPE` records remain
terminal until their exact cause is independently reconciled.

The narrow `inspect_scope_worktree` action is read-only. It checks that the
blocker names a stale/predecessor worktree discrepancy (not new functional
scope), that the current WU is exactly next after completed frozen predecessors,
that work is settled, that `git rev-parse HEAD` is the *exact verified merge
commit of the last completed WU*, that tracked paths are clean, and that every
final predecessor candidate overlay file matches its SHA-256 from the immutable
candidate registry. A checkpoint note alone is never proof.

`reconcile_stale_worktree_scope(expected_revision, blocked_at_revision)`
performs that inspection again and commits one `SCOPE_WORKTREE_RECONCILE`
event through the ordinary CAS/lease-fenced controller. It preserves the
original blocker, work-unit scope, completed WUs, budget, receipts and candidates
as durable history. It is not a general `clear_blocker` for BLOCKED_SCOPE and
does not authorize new functional scope, production data changes, or a security
waiver. A changed Git head, changed tracked file, missing candidate/merge,
unsettled dispatch, new WU candidate, or true scope conflict fails closed.

The supervisor may wake the root **once** for read-only proof and the exact
reconciliation attempt. It never performs automatic scope widening or an
unverified blocker clear. Existing reviews/CI/merge checks still apply.

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
   CI evidence only for checks named by the effective mandate. With `[]`,
   skip CI and use the remaining governed merge/verification gates, then
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

## Process repair without renewed per-WU authority

An owner-approved `process_policy` decision can delegate transparent TDD ordering
recovery for the remaining Epic. `adopt_process_policy` records its exact source
once. `start_process_recovery` moves a covered `TDD_ORDER` deviation to repair,
without accepting the work. A legacy authority blocker requires its exact
`status.blocker_fingerprint` in the approved policy; other authority remains intact.
See the orchestrator template for the envelope and full transition sequence.

Register executed negative baseline/mutation receipts with
`record_process_evidence`, restore full GREEN, freeze the final candidate and
prepare an independent reviewer with its `candidate_id`. After handoff and
reconciliation, `record_process_review` reads the reviewer's exact `process_review`
attestation. The verdict is bound to candidate and evidence set. Ordinary review,
CI, merge and WU completion still apply. A missing-module failure alone is not
behavioral acceptance. `record_red` is available for structured TDD obligations;
it establishes observed baseline failure, not unobserved historical edit order.

The worker context carries all current-WU authority resolutions. Proposed additive
verification checks may be adopted when `technical_verification` is delegated;
existing checks, setup, capabilities and environment cannot be weakened by that
route. Semantic substitutions require their applicable approved source.

External-wait expiry is observational: the merge wrapper reads the current remote
condition first. An old timeout can recover after terminal exact-binding evidence;
the normal merge path revalidates before any side effect. The supervisor may wake
the root once to observe an expired wait, never to clear unrelated blockers or
fabricate CI success. User interruption remains authoritative.
