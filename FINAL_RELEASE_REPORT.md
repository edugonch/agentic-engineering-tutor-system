# FINAL_RELEASE_REPORT — Harness v1

Owner-authorized Phase 5 finalization. Finalization only: no new architecture,
no Phase-4 repair, no governance redesign, no new fault-injection program.

## Release status

```text
HARNESS_V1 = RELEASE_CANDIDATE
Remaining gate: owner reloads OpenCode at the frozen baseline SHA, then one
supported happy-path smoke execution is run (packet prepared; see §9).
```

The release is finalized except for the single owner-gated reload + smoke step.
`HARNESS_V1 = RELEASE_READY` is **not** claimed yet, because the definition of
done requires a real happy-path smoke on the frozen revision, which cannot be
executed while the runtime still has a Phase-4 plugin revision loaded.

## 1. Exact baseline SHA

| Field | Value |
|---|---|
| Frozen v1 baseline | `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848` |
| Provenance | Accepted Phase 3 SHA; `refs/heads/main` locally and on `origin`; E01 `COMPLETE`, WU-01 PASS |
| Finalization branch | `phase-5-v1-finalization` (based on the frozen SHA) |
| Phase-4 experiment | branch `phase-4-bounded-repair` (preserved history, not v1) |
| Node / OpenCode | Node v20.19.5 / OpenCode v2.0.18 (observed) |

The v1 product was frozen at the accepted Phase 3 capability level. Phase 4 is
not part of the release (see §10).

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

## 4. Git install / update verification

- `git ls-remote origin main` → `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`
  (the frozen SHA is the remote default branch).
- Documented install (exact revision pin):

  ```sh
  opencode plugin add 'github:edugonch/agentic-engineering-tutor-system#dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848'
  ```

- A configured plugin revision is not loading proof. Confirmed loading happens
  after the owner reloads; the current process still reports the Phase-4 revision
  `bec2876b` (see §6).

## 5. Runtime readiness

`harness_check_agent_readiness` and `harness_project_status` report `ready: true`
for `harness-builder` and `harness-reviewer` (subagents), with the four managed
profiles unchanged. Re-confirmed after the plugin was re-pointed to the frozen
baseline: the live Code Mode tool surface then showed the baseline operation set
(no `authorize_repair` / `authorize_recovery` / `resolve_blocker`), and readiness
remained ready. A clean owner restart is still the specified gate before the
smoke run.

## 6. Loaded-runtime gap (owner action required)

The globally configured plugin currently resolves to a Phase-4 commit:

```text
before: git+https://github.com/edugonch/agentic-engineering-tutor-system.git#bec2876bbcee8e4f48fc9cef81844330680680fe
after:  git+https://github.com/edugonch/agentic-engineering-tutor-system.git#dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848
```

The global plugin entry has been re-pointed to the frozen baseline, with a
backup of the prior config at
`~/.config/opencode/opencode.json.pre-phase5-v1-baseline-backup`. After the
re-point the live tool surface changed to the baseline operation set and
readiness re-checked ready, consistent with the baseline loading (the server
hot-reloaded the config). `opencode plugin list` run from the finalization branch
returned `No plugins found`; this should be re-checked after a clean restart.

**Owner action:** restart/reload OpenCode cleanly, start a session in the smoke
sandbox, then confirm `opencode plugin list` shows the frozen SHA and readiness
is ready before running the smoke.

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

Prepared, not yet executed (owner-gated reload). The packet was pre-validated:

- `smoke-behavior` and `smoke-test` both PASS in a materialized
  `package.json + src/resolve-binary.js + tests/harness-v1-smoke.test.js`
  workspace (6/6 subtests PASS).
- Prepared Epic SHA-256:
  `77fac6c0e05808dbd8f5e150d38dad3d83d24ae90d2c163e4d1a4ba5bd84eac9`.
- Prepared verification-contract hash:
  `4184d7dfe00bc17f4e75f22914f774cffac97252762c0a4ff2769b4a820a1738`.
- Disposable sandbox: `/Users/poseidon/Documents/agentic-engineering-tutor-system/harness-v1-smoke`
  (clean clone at the frozen SHA, no execution state, smoke packet copied in).

Execution evidence fields to fill after the smoke run: loaded revision,
readiness, Epic `record_key`, mandate id/revision, candidate id, manifest/tree
hash, both `verify-<hash>` receipts, reviewer session + PASS, completion event.
A STOP at any point is a release-blocking finding and must be recorded, not
retried or repaired.

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
opencode plugin add 'github:edugonch/agentic-engineering-tutor-system#dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848'
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
| Exact supported baseline identified | DONE — `dbe8beb0…` |
| Tests/validation for the baseline pass | DONE — 241/241, 68 paths |
| Plugin installs/loads from the documented Git revision | Install verified on `origin` and re-pointed globally; baseline surface observed live; **clean restart recommended** |
| Fresh builder/reviewer readiness passes | DONE — `ready: true` for builder/reviewer, re-confirmed after re-point |
| One real v1 happy-path smoke succeeds | **PENDING** (packet prepared, sandbox ready) |
| Operator documentation exists | DONE |
| Phase-4 recovery limitation documented | DONE |
| ALFRAN Dev and LLM Learning can start using it | Onboarding documented; requires owner-approved import |

## 15. Next step (owner)

1. Restart/reload OpenCode so the frozen baseline plugin is loaded.
2. Start a session in `/Users/poseidon/Documents/agentic-engineering-tutor-system/harness-v1-smoke`
   (or `session_move` there).
3. Confirm `opencode plugin list` shows `dbe8beb0…` and readiness is ready.
4. Execute `docs/phase-5-smoke/SMOKE-RUNBOOK.md`.
5. Fill §9 with the real evidence and commit on `phase-5-v1-finalization`.

When step 4 yields `complete_wu` with a reviewer PASS bound to real receipts,
report `HARNESS_V1 = RELEASE_READY` and STOP. No Phase 6.
