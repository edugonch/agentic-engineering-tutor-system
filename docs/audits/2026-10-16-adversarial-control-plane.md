# Adversarial Harness Control-Plane Audit — 2026-10-16

**Scope:** the repeated ALFRAN EPIC-05 / E05-04-E interruption after WU predecessors E05-01..03 completed, plus cross-cutting control-plane failure modes. **Baseline:** Harness `main` at `8d35307858a2508d9b6273e889ccd6344caea661`, PRs #52–#55. This audit is based on tracked source, tests, CI and the owner's supplied runtime report. The live local `.harness/execution/controller/alfran-epic05-delivery/events.ndjson`, candidate registry and OpenCode session are not remotely accessible: any claim about the exact contents of blocker 469 is conditional until those exact facts are read in the runtime.

## Independent evidence and observed facts

- ALFRAN local session moved to a clean `recovery/e05-04` worktree. The report shows Git HEAD `e54553a85a7b8c531984531f0f32d6716c9a9da0`, merged PR #216/#217, and both predecessor files tracked, but `inspect_scope_worktree` returned not eligible as a “genuine scope blocker” before Git proof.
- `src/execution/scope-recovery.js`: `isStaleWorktreeScopeBlocker` only recognizes a shortlist of English phrases; it does **not** recognize `untracked` by itself or a named predecessor filename. A truthy `blocker.authority_question` forces `false`. This boolean gates both inspection and reconciliation. `controller-tool.js` maps that `false` to “Genuine scope changes remain blocked”; this is an invalid implication.
- OpenCode V2 plugin SDK describes `ctx.location` as the **plugin-instance** location, *not* the location of every session it serves. `index.js` freezes `ctx.location.project.canonical` during setup and reuses it for both the canonical controller and Git operations, while `opencode.session_move` changes a session's directory. This is a separate unverified working-directory hazard; an actual session can inspect a different worktree from the plugin root.
- `scope-recovery.js` accepts a single synthetic predecessor in its end-to-end positive test, with a reason chosen to satisfy its own classifier. It does not exercise three preceding WUs, a real-life `untracked` wording, a preserved active WU draft, or differing canonical/session directories.
- Current scope recovery requires an exact previously verified merge head plus every prior candidate overlay file's hash. Those are useful checks and must remain. No unconditional `clear_blocker`, journal mutation or scope enlargement is safe.
- `tests/plugin-wiring.test.js` uses a fake empty event subscription, fake session get/prompt, and no session relocation. Unit tests of `supervisor.tick` establish delivery attempts, not end-to-end autonomous completion.
- `.github/workflows/validate.yml` runs `npm run check` plus mutation suites on Node 20/22/24. All passing confirms the **given assertions** pass, not that the fixture covers incident vocabulary or a real OpenCode location boundary.
- PR #52 normalized a contract under planning estimates; PR #53 corrected JIT triage; PR #54 corrected continuation acknowledgment; PR #55 corrected narrow stale-scope reconciliation. These repaired distinct adjacent failure modes, but lacked an integrated real-world adverse-case acceptance test and no real runtime canary was recorded.

## Findings / severity

| ID | Severity | Defect / failure mode | Adversarial required test |
| --- | --- | --- | --- |
| A-01 | CRITICAL | A free-text regex is treated as the authority gate for recovery. “untracked”, changed casing, paths, or reason synonyms can block legitimate reconciliation. | Reproduce legacy `BLOCKED_SCOPE` about **untracked predecessor artifacts** and verify that eligible/ambiguous are distinguished by observed Git/candidate evidence rather than a magic phrase. |
| A-02 | CRITICAL | Plugin canonical project checkout and live session working directory are conflated. `session_move` can leave Git verification aimed at another checkout while state stays canonical. | Simulate two checkouts: canonical stale, moved session clean. Prove Git read targets the verified session's checkout, while controller/candidate registry stay anchored canonically. |
| A-03 | HIGH | “NOT_ELIGIBLE” is rendered as “Genuine scope change” without proof. | Unrecognized legacy text must never be reported as a demonstrated functional scope expansion. Return typed `EVIDENCE_REQUIRED`, `SOURCE_UNAVAILABLE`, or `SCOPE_CONFLICT` with exact gate. |
| A-04 | HIGH | Happy-path scope fixture has one predecessor, convenient reason, clean single checkout; no ALFRAN-like multi-WU case. | Three WUs completed, successive Git commits/merges and immutable overlays, true `HEAD` at latest merge, active fourth WU, historical blocker revision. |
| A-05 | HIGH | Scope clearance relies on legacy reasons that were never typed at blocker creation; arbitrary text must not grant new business authority. | Explicit *real scope expansion* mentioning “worktree” or predecessor file must remain blocked; typed `authority_question` product/scope remains blocked; historical ambiguous cause requires bounded provenance, not guessed approval. |
| A-06 | HIGH | Worktree recovery assumes all recorded prior candidate output files are present, regular and byte-exact in the current checkout. An unavailable registry or missing merge index is not equivalent to real scope change. | Missing candidate/merged receipt returns `EVIDENCE_UNAVAILABLE`, does not erase blocker, and reports the exact underlying dependency. |
| A-07 | MEDIUM | State transition and tool preflight have duplicated guards; true authorization must be enforced in `state.js`, with input/evidence acquisition in tools. | Call the controller with wrong revision, wrong WU, dirty source and out-of-scope data; prove rejection in state, no journal event written. |
| A-08 | HIGH | Running a new positive test that mirrors new code is insufficient; RED must reproduce the incident **before** implementation, not after. | Commit only independent incident/negative tests first, observe CI RED, preserve exact failed test IDs, then implement minimal correction. |
| A-09 | MEDIUM | Historical transaction safety and last-merge identity can be conflated with dynamic active aliases. | Validate `state.merges` index/history and `completed_wus` against exact source commits, with no duplicate/forged merge evidence. |
| A-10 | HIGH | Continued run can still stall after a builder handoff even if scope recovery succeeds; recent supervisor changes require a real provider canary. | Contract test: terminal child => read handoff => reconcile => candidate => independent review; and real-provider canary, with no invented PASS. |
| A-11 | CRITICAL | `harness_freeze_candidate` also called `trackedCandidatePaths()` and `freezeCandidate()` on the plugin’s frozen canonical root, excluding a document that exists **only** in the session-moved recovery worktree. | A real plugin registration test: file only in linked session worktree must appear in frozen candidate; registry remains canonical. |

## Boundaries for any fix

1. Separate **canonical durability root** (controller, candidate registry, indexed authorities) from **session checkout root** (Git / worktree inspection). Accept only a runtime-provided, independently verified session location in the same Git project. Never trust a free-form path supplied by the model.
2. Don't reinterpret all `BLOCKED_SCOPE` as recoverable, don't mutate historical BLOCK/CLEAR events and don't use owner-written prose as cryptographic evidence. Historical Git-mismatch cases require positive content and lineage proof plus an exact blocker reference; genuinely ambiguous legacy causes remain blocked with a precise next action.
3. No destructive `git reset`, `clean`, force push, manual state edits, spoofed approvals, WU reordering, budget changes or skipped CI/review.
4. Preserve previous candidate hashes/PR merges; the active E05-04 document is not part of the E05-01–03 predecessor artifacts and must not be silently absorbed.
5. An adverse test suite passing in CI is *necessary but insufficient* to claim that the user’s local controller was unblocked. Record the selected `checkout_root`, `canonical_root`, `HEAD`, blocker fingerprint, source path and exact failure class in the read-only inspection report. The real runtime canary must confirm installation, dispatch continuity and any authorized resolution.

## Recorded RED evidence and corrective requirements

- **Run 38951224208** (pre-fix): RED `untracked` legacy classifier returned `NOT_ELIGIBLE` rather than `VERIFIED_RECONCILABLE`; false new `BLOCKED_SCOPE` registration was accepted when the old blocker had been cleared.
- **Run 38951559652** (pre-fix): three completed predecessors + fourth active WU in a linked worktree returned `NOT_VERIFIED` against stale canonical HEAD, even though the live session checkout was at the verified latest merge.
- **Run 38952422160** (pre-freeze-fix): actual registered plugin froze a candidate that omitted `docs/ONLY-IN-MOVED-SESSION.md`, because it read the canonical checkout rather than the moved session checkout.
- Another old test fixture failed on missing `Session.Info.location.directory` after adding strict runtime identity verification; this is a **fixture deficiency**, not permission to silently fall back to `ctx.location.project.canonical`. The fixture must model the real session location.
- The original block revision 469's **literal full reason** remains unavailable in GitHub; no assertion that production ALFRAN has been unblocked may be made from CI alone.

**Fix split:** controller/event log/candidate registry/authorities stay in the canonical root; only Git checkout reading and candidate file capture use the authenticated current root session location after verification of Git common-dir. Reject a session from a foreign Git repository, a missing location, a child session, and an actual product/scope authority question.

## RED → GREEN evidence protocol

- Stage source-grounded negative tests before implementation; run exact-head CI and capture expected failure(s).
- Implement with a small, auditable diff, retaining negative tests. Re-run `npm run check` and recovery/source mutation suites on Node 20/22/24.
- Inspect current PR diff and execution pathways; obtain independent reviewer whenever possible. Do not claim a nonexistent independent review.
- Merge only an exact tested HEAD when all required checks pass and the code has no known safety regression.
