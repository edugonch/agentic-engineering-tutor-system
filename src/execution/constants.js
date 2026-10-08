// Phase 0 execution-control-plane semantics: shared enumerations.
//
// These values are the typed vocabulary of the durable execution core. They are
// intentionally data, not prose, so no authority transition depends on
// interpreting natural language. See docs/execution-control-plane.md for the
// contract each value participates in.

export const OPERATION_TYPES = Object.freeze([
  "MANDATE_APPROVE", // owner-approved Epic execution mandate (initial authority input)
  "MANDATE_AMEND", // versioned owner-approved policy amendment; budget/scope remain immutable
  "WU_BUDGET_AMEND", // approved WU-only additional allocation and atomic budget-block recovery
  "WU_ACTIVATE", // derive + activate a WU authorized by the mandate (JIT)
  "PHASE_START", // enter a budget phase (ACTIVE / WAITING_* / PAUSED)
  "PHASE_END", // leave a budget phase and settle its billable time
  "DISPATCH_RESERVE", // reserve budget for an external execution attempt
  "DISPATCH_PREPARE", // reserved -> pending_launch (before a session id is known)
  "DISPATCH_LAUNCH_CLAIM", // pending_launch -> pending_launch (durably record a claimed launch attempt before the side effect)
  "DISPATCH_LAUNCH", // pending_launch/reserved -> launched, attach session id
  "DISPATCH_FINISH", // launched -> finished, attach result
  "DISPATCH_RECONCILE", // finished -> result_reconciled, settle reservation into consumption
  "DISPATCH_RELEASE", // reserved/pending_launch (never launched) -> released, return reservation
  "DISPATCH_MARK_AMBIGUOUS", // reserved/pending_launch -> ambiguous (identity unknown); reservation stays held
  "DISPATCH_RESOLVE_AMBIGUOUS_LAUNCH", // ambiguous -> launched after exact external session identity is independently recovered
  "FREEZE_CANDIDATE", // pin an immutable candidate (manifest hash + tree hash), bound to the active WU
  "RECORD_REVIEW", // bind a review verdict to one exact candidate's hashes
  "WU_COMPLETE", // close one WU: candidate + PASS review + settled dispatches (distinct from EPIC COMPLETE)
  "CHECKPOINT", // persist a resumable checkpoint
  "BLOCK", // record a governed stop (typed blocker class)
  "AUTHORITY_RESOLVE", // apply an explicit approved decision to an exact authority stop
  "CLEAR_BLOCKER", // resolve one explicitly recoverable blocker after its cause is repaired
  "COMPLETE", // record EPIC_EXECUTION_VERIFIED (technical completion, not owner acceptance)
  "BIND_PR", // immutably bind a GitHub PR to the active WU's frozen candidate (repository, pr_number, head/base SHA)
  "RECORD_CI", // record exact-head CI evidence for one check, bound to a candidate (multiple checks per candidate)
  "MERGE_START", // governed merge: evaluate structural gates and mark the merge started (no external side effect)
  "MERGE_EXTERNAL_RECORD", // human policy: record an already-performed external merge (source=HUMAN_EXTERNAL), never executes a merge
  "MERGE_RECORD", // record the remote merge result (merge_commit_sha + merged head) after the side effect
  "MERGE_VERIFY", // verify the recorded merge matches the expected head (fail closed on drift)
])

export const PHASE_STATES = Object.freeze({
  ACTIVE: "ACTIVE",
  WAITING_OWNER: "WAITING_OWNER",
  WAITING_EXTERNAL: "WAITING_EXTERNAL",
  PAUSED: "PAUSED",
})

// Only ACTIVE phases bill against the budget. The controller measures wall
// clock; it never trusts a model-reported elapsed time.
export const BILLABLE_PHASES = new Set([PHASE_STATES.ACTIVE])

export const DISPATCH_STATUS = Object.freeze({
  RESERVED: "reserved",
  PENDING_LAUNCH: "pending_launch",
  LAUNCHED: "launched",
  FINISHED: "finished",
  RESULT_RECONCILED: "result_reconciled",
  RELEASED: "released",
  AMBIGUOUS: "ambiguous",
})

// Naming encodes the launch boundary, and the values are intentionally
// distinct so no two states can silently alias:
//   PENDING_LAUNCH   = we are before/during the launch boundary.
//   LAUNCHED         = launch confirmed AND external identity known.
//   AMBIGUOUS        = the side effect may have occurred, but we do not have
//                      enough identity; never auto-launch/retry from here.
//   FINISHED         = the identified execution terminated (result attached).
//   RESULT_RECONCILED = the result has been durably incorporated.
export const TERMINAL_DISPATCH_STATUSES = new Set([
  DISPATCH_STATUS.RESULT_RECONCILED,
  DISPATCH_STATUS.RELEASED,
  DISPATCH_STATUS.AMBIGUOUS,
])

// Reservation sub-state, independent of the dispatch lifecycle. A dispatch may
// hold a reservation while its status is anything except RELEASED /
// RESULT_RECONCILED. The aggregate reserved_seconds is a projection of these.
export const RESERVATION_STATUS = Object.freeze({
  RESERVED: "reserved",
  RELEASED: "released",
  CONSUMED: "consumed",
})

// Typed blocker classes. Only a subset allow automatic recovery, and that
// policy is the Phase 4 concern. Phase 0 implements BLOCKED_PERMISSION as a
// hard stop with no alternative-execution fallback.
export const BLOCKER_CLASSES = Object.freeze([
  "BLOCKED_PERMISSION",
  "BLOCKED_TOOLING",
  "BLOCKED_EXTERNAL_FACT",
  "BLOCKED_ARCHITECTURE",
  "BLOCKED_AUTHORITY",
  "BLOCKED_SECURITY",
  "BLOCKED_SCOPE",
  "NO_PROGRESS",
  "BUDGET_EXHAUSTED",
])

// Blockers that forbid forward execution (new WUs, new billable phases, or new
// dispatches). The recoverable classes (TOOLING / EXTERNAL_FACT / ARCHITECTURE)
// are intentionally excluded here; their bounded-recovery policy is a later
// phase. This set makes "no alternative execution after a hard stop"
// structural, not a prompt instruction.
export const TERMINAL_BLOCKER_CLASSES = new Set([
  "BLOCKED_PERMISSION",
  "BLOCKED_AUTHORITY",
  "BLOCKED_SECURITY",
  "BLOCKED_SCOPE",
  "NO_PROGRESS",
  "BUDGET_EXHAUSTED",
])

// Recoverable blockers may be cleared only through an explicit audited
// transition after the underlying condition has been repaired. Hard-stop
// blockers are deliberately excluded and cannot be cleared by this mechanism.
export const RECOVERABLE_BLOCKER_CLASSES = new Set([
  "BLOCKED_TOOLING",
  "BLOCKED_EXTERNAL_FACT",
  "BLOCKED_ARCHITECTURE",
])

// Execution authorization is distinct from artifact approval. A JIT WU may be
// artifact-status PROPOSED while its execution is AUTHORIZED_BY_MANDATE. The
// two questions ("who approved this document?" vs "does the controller have
// authority to run this transition?") must never collapse into one field.
export const EXECUTION_AUTHORIZATION = Object.freeze({
  AUTHORIZED_BY_MANDATE: "AUTHORIZED_BY_MANDATE",
  OWNER_DIRECTED: "OWNER_DIRECTED",
})

// How a WU came into existence. A WU derived from an approved mandate is
// DERIVED; it is never APPROVED (that would conflate artifact approval with
// execution authority).
export const WU_ORIGIN = Object.freeze({
  DERIVED: "DERIVED",
})

// The kind of authority a mandate carries. PROBE is Phase 0 instrumentation and
// cannot authorize a governed WU; OWNER_APPROVED_EPIC is the only kind the
// public activate_wu path accepts.
export const MANDATE_AUTHORITY = Object.freeze({
  PROBE: "PROBE",
  OWNER_APPROVED_EPIC: "OWNER_APPROVED_EPIC",
})

// Conclusion vocabulary for exact-head CI evidence recorded via RECORD_CI.
// Only SUCCESS can satisfy a governed merge gate (enforced by the merge policy,
// not by RECORD_CI itself); the others are recorded for audit but never gate.
export const CI_CONCLUSIONS = Object.freeze(["SUCCESS", "FAILURE", "PENDING", "ERROR"])

// Governed merge policy. Derived from approved Epic authority. Initial policy is
// recorded at MANDATE_APPROVE; a later MANDATE_AMEND may replace only policy
// fields from a new APPROVED Epic artifact while preserving budget/scope. Policy
// values can never come directly from a tool input.
//   none          — the Harness neither requires nor executes a merge.
//   human         — the Harness may record/verify an external merge, never execute one.
//   governed_auto — the Harness may execute a merge once every structural gate passes.
export const MERGE_POLICIES = Object.freeze(["none", "human", "governed_auto"])
