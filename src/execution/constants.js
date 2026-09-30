// Phase 0 execution-control-plane semantics: shared enumerations.
//
// These values are the typed vocabulary of the durable execution core. They are
// intentionally data, not prose, so no authority transition depends on
// interpreting natural language. See docs/execution-control-plane.md for the
// contract each value participates in.

export const OPERATION_TYPES = Object.freeze([
  "MANDATE_APPROVE", // owner-approved Epic execution mandate (the sole human authority input)
  "WU_ACTIVATE", // derive + activate a WU authorized by the mandate (JIT)
  "PHASE_START", // enter a budget phase (ACTIVE / WAITING_* / PAUSED)
  "PHASE_END", // leave a budget phase and settle its billable time
  "DISPATCH_RESERVE", // reserve budget for an external execution attempt
  "DISPATCH_PREPARE", // reserved -> pending_launch (before a session id is known)
  "DISPATCH_LAUNCH", // pending_launch/reserved -> launched, attach session id
  "DISPATCH_FINISH", // launched -> finished, attach result
  "DISPATCH_RECONCILE", // finished -> result_reconciled, settle reservation into consumption
  "DISPATCH_RELEASE", // reserved/pending_launch (never launched) -> released, return reservation
  "DISPATCH_MARK_AMBIGUOUS", // reserved/pending_launch -> ambiguous (identity unknown); reservation stays held
  "FREEZE_CANDIDATE", // pin an immutable candidate (manifest hash + tree hash)
  "RECORD_REVIEW", // bind a review verdict to one exact candidate's hashes
  "CHECKPOINT", // persist a resumable checkpoint
  "BLOCK", // record a governed stop (typed blocker class)
  "COMPLETE", // record EPIC_EXECUTION_VERIFIED (technical completion, not owner acceptance)
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

// Execution authorization is distinct from artifact approval. A JIT WU may be
// artifact-status PROPOSED while its execution is AUTHORIZED_BY_MANDATE. The
// two questions ("who approved this document?" vs "does the controller have
// authority to run this transition?") must never collapse into one field.
export const EXECUTION_AUTHORIZATION = Object.freeze({
  AUTHORIZED_BY_MANDATE: "AUTHORIZED_BY_MANDATE",
  OWNER_DIRECTED: "OWNER_DIRECTED",
})
