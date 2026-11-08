# Harness delivery-engine refactor — consolidated implementation

This document replaces the earlier staged-router roadmap. The code lives in
one pull request, with one CI suite and one reviewed merge. No owner authority,
Epic or WU budgets, journal rows, launch claims, child fences, acceptance
requirements, review or merge evidence were relaxed.

## What the integrated refactor changed

- **One deterministic route:** `workflow-router.js` remains the shared
  read-only projection for operational status, supervisor dispatch state and
  triage; the controller alone authorizes mutations.
- **Automatic continuation of a temporary stability hold:** `supervisor.js`
  uses the same `orphan-circuit-breaker.js` calculation as `prepare_launch`.
  When the active WU is ready for a single builder and the guard is holding,
  the supervisor schedules one observation for the precise expiry, restores the
  timer on `supervisor.resume()`, re-reads the actual event log and only then
  sends a continuation to the already-bound root. No builder or reservation is
  created by the timer. A live/claimed dispatch is never replaced.
- **Reliable runtime evidence:** use observed OS process startup time rather
  than plugin load time for the runtime stability window. A hot plugin reload
  does not erase the process's preexisting uptime; a new process resets it.
  Readiness separately reports plugin load and process information. It still
  does not claim a server restart absent process/log proof.
- **Single effect classification:** `dispatch-handoff.js` and governed orphan
  recovery use the same `classifyOrphanReadTools` function and report a
  read-only eligibility diagnostic. The handoff does not establish permission,
  quiescence, a terminal result, or a safe abandon. Approved exact or bounded
  authority, independent runtime checks and durable fencing remain mandatory.
- **Shorter orchestrator context:** the managed profile is ~76% smaller than
  before. All always-on safety invariants, explicit finite WU sequence,
  architecture challenge, batching, RED/verification, review and merge gates
  remain in the managed profile. Rare historical/external recovery details
  remain verbatim in `docs/orchestrator-procedures.md` for targeted reads.
- **Compact supervisor model context:** `supervisor-prompt.js` produces one
  deterministic small instruction bound to the active route/triage. It does not
  carry the entire project story into each retry.
- **Delivery accountability:** `operational_status.delivery_metrics` reports
  real completed-WU receipts, settled dispatch seconds, unknown time,
  conservatively charged orphan seconds, and unsettled dispatches. It never
  labels model/worker runtime as verified productive engineering hours.

## Non-regression evidence

The same PR runs the entire existing `npm run check` suite and the recovery
and source-access mutation suites in Node 20, 22 and 24. Additional tests
exercise the persisted supervisor timer across restarts with two abandoned
builders, active-child refusal, safe handoff/recovery effect parity, truthful
metrics, compact supervisor instructions, and immutable orchestrator guardrails.

## Explicit operational limitation

This is a complete consolidated **code refactor of the delivery and recovery
orchestration paths**, not a claim that a private local OpenCode server or
ALFRAN's E05-27-E has completed successfully. GitHub CI cannot operate the
user's local OpenCode sessions. The end-to-end production canary must validate
real host restarts, policy limits, actual implementation and one small grouped
candidate without weakening the safety gates. There is no authorization to
modify ALFRAN's event log, produce fake review/CI PASS receipts or bypass
unfinished WUs.
