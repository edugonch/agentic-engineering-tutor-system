# FINAL_RELEASE_REPORT — Harness v1

Owner-authorized Phase 5 finalization. Finalization only: no new architecture,
no Phase-4 repair, no governance redesign, no new fault-injection program.

## Release status

```text
HARNESS_V1 = RELEASE_READY
PHASE_5    = PASS
```

The released plugin candidate is
`8c8842a5ccb55eefb1aae6c7068c3e00e036d5a7`, the single child of the accepted
frozen baseline `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848` that removes the
default 40-call tool ceiling (`HARNESS_MAX_TOOL_CALLS` is now opt-in; total tool
calls are unlimited by default). The supported happy-path smoke executed
end-to-end on this exact revision and reached `complete_wu`; §9 records the
actual evidence. The owner-gated reload + smoke step is closed. No Phase 6.

## 1. Exact baseline SHA

| Field | Value |
|---|---|
| Frozen v1 baseline (parent) | `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848` |
| Released plugin candidate | `8c8842a5ccb55eefb1aae6c7068c3e00e036d5a7` (single child of the baseline) |
| Provenance | Accepted Phase 3 SHA; `refs/heads/main` locally and on `origin`; E01 `COMPLETE`, WU-01 PASS |
| Finalization branch | `phase-5-v1-finalization` (released candidate integrated with the prepared Phase-5 documentation) |
| Phase-4 experiment | branch `phase-4-bounded-repair` (preserved history, not v1) |
| Node / OpenCode | Node v26.3.0 / OpenCode v2.0.18 (final smoke + release-tree verification runtime) |
| Implementation delta (baseline → released) | `README.md`, `src/turn-guard.js`, `tests/turn-guard.test.js` only |

The v1 product was frozen at the accepted Phase 3 capability level and ships
exactly one post-freeze fix: removal of the default 40-call ceiling, so the
supported happy path is not cut short by a total-call fuse. The delegation and
repeated-mutation fuses are unchanged. Phase 4 is not part of the release
(see §10).

## 2. Authority

- Owner decision (2026-10-03): close Phase 4 as FAIL (`RECOVERY_LIVENESS_GAP`),
  start Phase 5 finalization, freeze the v1 ceiling at the last fully accepted
  capability level, and do not depend on Phase-4 autonomous repair/recovery.
- Recorded in `.harness/PROJECT_CHARTER.md` (Decision history),
  `.harness/PROJECT_STATE.md`, `.harness/PROJECT_STORY.md`, and
  `docs/phase-4-final-status.md`.

## 3. Baseline test / validation status

Executed in a clean worktree at `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`:

| Check | Command | Result |
|---|---|---|
| Unit/regression suite | `npm test` | **241 passed, 0 failed, 0 skipped** |
| Package validation | `npm run validate` | **PASS — 68 core paths + V2 hooks + profiles + skills** |
| Git whitespace | `git diff --check` | PASS (clean worktree) |

Raw tail: `# tests 241 / # pass 241 / # fail 0`; validation output
`Validated 68 core paths, V2 plugin hooks, OpenCode agent profiles, and skill metadata.`

Re-verified on the finalization tree before publication (released candidate
`8c8842a5` + prepared Phase-5 documentation):

| Check | Command | Result |
|---|---|---|
| Unit/regression suite | `npm test` | **243 passed, 0 failed, 0 skipped** |
| Package validation | `npm run validate` | **PASS — 68 core paths + V2 hooks + profiles + skills** |
| Git whitespace | `git diff --check` | **PASS** (no whitespace errors) |

The +2 tests over the baseline are the `8c8842a5` `turn-guard` cases that pin
the new unlimited-by-default tool-call behavior.

## 4. Git install / update verification

- `git ls-remote origin main` → `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`
  (the frozen baseline remains the remote default branch).
- Released revision: `8c8842a5ccb55eefb1aae6c7068c3e00e036d5a7` (parent
  `dbe8beb0…`), published on `phase-5-v1-finalization`.
- Documented install (exact revision pin):

  ```sh
  opencode plugin add 'github:edugonch/agentic-engineering-tutor-system#8c8842a5ccb55eefb1aae6c7068c3e00e036d5a7'
  ```

- A configured plugin revision is not loading proof. Loading of the released
  candidate was confirmed in `~/.local/share/opencode/log/opencode.log`:

  ```text
  2026-10-03T20:11:57.226Z level=INFO run=a68d9a45 msg="loading plugin"
    id=git+https://github.com/edugonch/agentic-engineering-tutor-system.git#8c8842a5ccb55eefb1aae6c7068c3e00e036d5a7
    entrypoint=file:///Users/poseidon/.cache/opencode/npm/git-agentic-engineering-tutor-system-cc737e869204/1791057705910/node_modules/opencode-agentic-harness/index.js
  ```

  Earlier entries loaded the Phase-4 revision `bec2876b` and then the baseline
  `dbe8beb0…`; the latest load is the released candidate `8c8842a5…`.

## 5. Runtime readiness

`harness_check_agent_readiness` and `harness_project_status` report `ready: true`
for `harness-builder` and `harness-reviewer` (subagents), with the four managed
profiles unchanged. Readiness was re-confirmed in the live released-candidate
runtime immediately before the final smoke; both required specialists were
available as subagents with no blocker. The live Code Mode surface shows the v1
operation set (no `authorize_repair` / `authorize_recovery` / `resolve_blocker`).

## 6. Loaded-runtime gap — CLOSED

The global plugin entry now resolves to the released candidate, and OpenCode has
loaded it:

```text
before: git+...#bec2876bbcee8e4f48fc9cef81844330680680fe  (Phase-4 experiment)
then:   git+...#dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848  (frozen baseline)
now:    git+...#8c8842a5ccb55eefb1aae6c7068c3e00e036d5a7  (released candidate)
```

Backups of the prior global config are preserved:
`~/.config/opencode/opencode.json.pre-phase5-v1-baseline-backup` (and
`.before-harness-plugin-fix`, `.before-plugin-cleanup`). The load of `#8c8842a5…`
is recorded in the OpenCode log (see §4). No owner action remains for v1.

## 7. Supported capability matrix (summary)

Full matrix: `docs/phase-5-v1-capability-matrix.md`.

- **Supported:** Git install/update; global specialist provisioning; readiness
  preflight + launch gate; new/existing project init; knowledge archive
  (record/search/read/import); story/Epic/WU validation; reference search; model
  routing; cost/loop fuses; opt-in Jev shadow signals.
- **Supported durable execution:** owner-approved Epic → `approve_mandate` →
  `activate_wu`; budget ledger; dispatch lifecycle (reserve/prepare/launch/
  finish/reconcile/release/mark-ambiguous); fencing/CAS/lease/operation identity;
  restart replay/status/recover; immutable content-addressed candidate; candidate-
  bound review; deterministic verification receipts; `block`; `complete_wu`.
- **Unsupported / experimental:** Phase-4 `authorize_repair`,
  `authorize_recovery`, `resolve_blocker`; autonomous handling of
  `CHANGES_REQUIRED`/blockers; fault injection and permission-denial probes;
  cryptographic reviewer identity; second review of the same candidate;
  merge/deploy/release/publish; broad process/network containment; Windows PATH.

### Supported v1 happy path (the autonomy ceiling)

```text
owner-approved Epic → derived/authorized WU → real builder → frozen candidate
  → deterministic verification → fresh independent reviewer → complete_wu
```

On any `CHANGES_REQUIRED` or blocker, control returns to the owner. v1 does not
autonomously repair or recover.

## 8. Operator documentation

- `docs/phase-5-v1-operator-guide.md` — install, update, start, approve Epic,
  normal execution, `CHANGES_REQUIRED`/`BLOCKED`, owner intervention rule.
- `docs/phase-5-v1-capability-matrix.md` — supported/unsupported/limitations.
- `docs/phase-5-v1-pilot-onboarding.md` — first use in ALFRAN Dev and LLM Learning.
- `README.md` — product overview (unchanged in scope).
- Smoke packet: `docs/phase-5-smoke/` (Epic, WU contract, verification contract,
  runbook).

## 9. Smoke-test evidence

Executed on the released candidate `8c8842a5…` in the isolated smoke sandbox
`/private/tmp/harness-v1-smoke-final` (execution `p5-smoke-final`). Result:
`complete_wu` with a fresh independent reviewer PASS bound to real receipts.
No blockers, no `CHANGES_REQUIRED`, no repair/recovery, no Phase 4.

```text
execution_id:                p5-smoke-final
plugin:                      8c8842a5ccb55eefb1aae6c7068c3e00e036d5a7
Epic:                        epic-p5-smoke-v1
record_key:                  2c6ef4d438d7732bdaf98fc67225c8eb0ef27517cfe64ef0448e3af85aa85cfd
approved artifact SHA:       75c17b99b92897a46d4f2d6539bc7765e0933edc7dbac360665efda8c0d91083
mandate:                     M-P5-SMOKE-FINAL (revision = approved artifact SHA)
WU:                          WU-P5-SMOKE-V1  DERIVED / AUTHORIZED_BY_MANDATE
builder session:             ses_efc96d567ffecJgECFuUTYj9cu
candidate:                   cand-42a1effc2e35e53f63ba5d87db8aef3c6198fd2014e24c59fd7c8952ee663e71
manifest:                    5b9135e623050ccf8574f1718be1ef503acf4f497e01bfff65e1c74efd5d459b
tree:                        a274ac3d48c0132835e2b33ef713017b2fe26a51d25b6c65bbaa3d090fb43c97
verification contract:       4184d7dfe00bc17f4e75f22914f774cffac97252762c0a4ff2769b4a820a1738
initial receipts             verify-deebb18332fa4a36eebe905d8384b065b47f930de6719e371506ddb883e23ec8  PASS smoke-behavior
                             verify-0a595f364359c3fe6361b23c4758d316f3d55dc45836b3863d4deae40d72e578  PASS smoke-test
reviewer session:            ses_efc958a86ffepoEGDuEDmHllN3 (fresh, harness-reviewer)
reviewer receipts            verify-bde98ec51d45c4208facf2f80181399029e21bd464a6bd22382bee65c3e5e8ba  PASS smoke-behavior
                             verify-0f74d5e5b586cb6dddd1e0ecb3f8826b68ae0f6cee5e46886f3e9bee56d23672  PASS smoke-test
review verdict:              PASS
complete_wu:                 true
controller invariants:       PASS — 6/6
budget:                      total 900 / used 600 / reserved 0 / available 300 / exhausted false / overrun false
notes:                       no failure injected; no repair/recovery used; happy path only
```

Both declared checks PASS on the frozen candidate: `smoke-behavior` (exit 0,
3/3 subtests) and `smoke-test` (exit 0, 3/3 subtests).

Builder deliverable: exactly one new file, `tests/harness-v1-smoke.test.js`
(SHA-256 `007f5f30cd888425bd9213bd1235484b050fbd7c1f3142c818174814045fa2be`);
no other file changed. The candidate identity above binds that content.

## 10. Known Phase-4 debt (preserved exactly)

`PHASE_4 = FAIL`; reason `RECOVERY_LIVENESS_GAP`. In the real `-004` runtime, a
recovery dispatch was settled after durable `action_claim` + `action_evidence`
PASS but before its required `tooling-ready` verification receipt. Afterwards
verification is correctly rejected without a live dispatch, the recovery cannot be
repeated, and durable ownership correctly prevents a fresh authority reset — so a
legitimate WU can be permanently stranded. This is real liveness debt, not budget
exhaustion, transport failure, double escaping, authority failure, candidate
corruption, permission widening, or a reason to weaken anti-replay ownership.

This debt is retained for future work and is **not solved** in v1. History for
`-002`, `-003`, `-004` and the failed R2 initialization is preserved immutable;
the partial `-004-R2/` directory containing only `lease.json` remains as
disclosed evidence. See `docs/phase-4-final-status.md`.

## 11. Installation command

```sh
opencode plugin add 'github:edugonch/agentic-engineering-tutor-system#8c8842a5ccb55eefb1aae6c7068c3e00e036d5a7'
# then restart/reload OpenCode and confirm:
opencode plugin list
```

## 12. First real use — ALFRAN Dev and LLM Learning

Prepared in `docs/phase-5-v1-pilot-onboarding.md`. Both projects are existing
repos with no `.harness` yet:

- ALFRAN Dev: `/Users/poseidon/Documents/alfran/alfran-web-platform`
- LLM Learning: `/Users/poseidon/Documents/eLearnProject/LLM-Learning`

Onboarding is additive (`governance_only` preferred first), requires a clean
starting SHA and explicit owner approval of the import mapping, and must not
capture secrets (e.g. `.env.local`) into the knowledge archive.

## 13. Explicit v1 limitations

1. No autonomous repair/recovery; `CHANGES_REQUIRED`/blockers return to owner.
2. Phase-4 recovery liveness debt retained, unsolved.
3. Verification/review are per-candidate; only the current candidate can close.
4. Cost fuses bound loops, not spend; set provider-side limits.
5. The baseline is Phase 3; Phase 4 code is not shipped.
6. Reviewer identity is session-based, not cryptographically attested.
7. No merge/deploy/release/publish automation.

## 14. Definition-of-done checklist

| Requirement | Status |
|---|---|
| Exact supported baseline identified | DONE — baseline `dbe8beb0…`; released candidate `8c8842a5…` |
| Tests/validation for the baseline pass | DONE — 241/241 at baseline; 243/243 on the finalization tree, 68 paths |
| Plugin installs/loads from the documented Git revision | DONE — OpenCode log records a load of `#8c8842a5…`; released surface observed live |
| Fresh builder/reviewer readiness passes | DONE — `ready: true` for builder/reviewer in the released runtime |
| One real v1 happy-path smoke succeeds | DONE — `p5-smoke-final` reached `complete_wu`, reviewer PASS, 6/6 invariants |
| Operator documentation exists | DONE |
| Phase-4 recovery limitation documented | DONE |
| ALFRAN Dev and LLM Learning can start using it | Onboarding documented; requires owner-approved import |

## 15. Publication

- Finalization branch `phase-5-v1-finalization` integrates the released candidate
  `8c8842a5` with the prepared Phase-5 documentation (exact commits `c95e469a`,
  `05ed3396`, `ac00433f` preserved) and records this final smoke evidence.
- Published to `origin/phase-5-v1-finalization`.
- The release is complete. Report `HARNESS_V1 = RELEASE_READY` and STOP. No
  Phase 6.

## Final smoke disclosures (non-blocking)

1. The earlier pre-fix smoke execution `p5-smoke-v1` remains stale/unfinished.
   It stopped in the `PENDING_LAUNCH` crash window before `record_launch`, under
   the since-removed 40-call ceiling.
2. That execution was **not** resumed, recovered, released, or reused; the
   successful final smoke ran as a fresh, isolated execution `p5-smoke-final`.
3. The orphan test file created by that aborted attempt was removed from the
   isolated smoke sandbox before the successful fresh execution.
4. The source smoke Epic document hash (`77fac6c0…`) and the registered
   immutable artifact hash (`75c17b99…`) differ because the registered artifact
   envelope includes generated metadata (`created_at`, generated `source_refs`).
   The mandate binds to the registered artifact hash after `findApprovedEpic`
   re-verifies the archived content.
5. Phase-4 autonomous repair/recovery remains unsupported/experimental because of
   `RECOVERY_LIVENESS_GAP` (see §10).
6. Harness v1 supports the accepted happy path only; `CHANGES_REQUIRED` and
   `BLOCKED` return control to the owner.

These are disclosures, not reasons to rerun the smoke.
