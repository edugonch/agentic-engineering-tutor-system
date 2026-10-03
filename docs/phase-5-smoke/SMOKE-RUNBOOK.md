# Harness v1 happy-path smoke — runbook

Run this **after** the owner reloads OpenCode with the frozen baseline plugin.
It proves the supported v1 happy path. It must not inject failure and must not
touch Phase-4 repair/recovery.

## Invariants (do not violate)

- Plugin must be loaded at `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`.
- No `repair_policy`. No `authorize_repair`, `authorize_recovery`,
  `resolve_blocker`, or fault injection.
- One Epic, one WU, one candidate, one independent review.
- Any deviation → STOP and report (a STOP is a release-blocking finding).

## Step 0 — disposable sandbox

Create a clean sandbox at `harness-v1-smoke` from the frozen baseline (do this
once; it must not contain Phase-4 execution state):

```sh
cd /Users/poseidon/Documents/agentic-engineering-tutor-system/agentic-engineering-tutor-system
git clone --no-local . /Users/poseidon/Documents/agentic-engineering-tutor-system/harness-v1-smoke
cd /Users/poseidon/Documents/agentic-engineering-tutor-system/harness-v1-smoke
git checkout --detach dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848
```

Then move the session into the sandbox (`tools.opencode.session_move` to
`/Users/poseidon/Documents/agentic-engineering-tutor-system/harness-v1-smoke`) or
start OpenCode there.

## Step 1 — loaded revision and readiness

- Confirm `opencode plugin list` shows the frozen SHA.
- Call `harness_check_agent_readiness`; require `ready: true` for
  `harness-builder` and `harness-reviewer`.
- Record the loaded revision and readiness JSON as evidence.

## Step 2 — install and register the smoke Epic

- Copy `docs/phase-5-smoke/epic.md` to
  `.harness/epics/epic-p5-smoke-v1.md` in the sandbox.
  Prepared identity: SHA-256
  `77fac6c0e05808dbd8f5e150d38dad3d83d24ae90d2c163e4d1a4ba5bd84eac9`.
- Register it as an **APPROVED Epic** artifact with
  `harness_record_knowledge_artifact` (`declared_authority: APPROVED`,
  `classification: EPIC`, `source_ref: .harness/epics/epic-p5-smoke-v1.md`),
  following the accepted `epic-phase3-wu01-v1` pattern.
- Record the returned `record_key` (`source_artifact_id`) and the file SHA-256.

Prepared verification contract hash (baseline `verificationContractHash`):
`4184d7dfe00bc17f4e75f22914f774cffac97252762c0a4ff2769b4a820a1738`.
Both declared checks were pre-validated in a materialized
`package.json + src/resolve-binary.js + tests/harness-v1-smoke.test.js` workspace
(6/6 subtests PASS).

## Step 3 — approve the execution mandate

`harness_execution_controller` `action: "approve_mandate"` with a new
`execution_id`, `mandate_id`, `mandate_revision`, `epic_artifact_id` =
the Epic `record_key`, `max_wus: 1`, `total_seconds: 900`, and the lease
`session_id`. No `repair_policy`.

## Step 4 — activate the derived WU

`action: "activate_wu"` with `wu_id: "WU-P5-SMOKE-V1"` and the mandate id.

## Step 5 — real build

1. `reserve` `dispatch_id: "build-smoke"`, `reserved_seconds: 300`.
2. `prepare_launch` `build-smoke`.
3. Delegate to `harness-builder` with the WU contract
   (`docs/phase-5-smoke/wu-contract.md`): it adds
   `tests/harness-v1-smoke.test.js` only.
4. `record_launch` with the builder's session id (lease `session_id`).
5. Verify no other file changed; then `record_finish` (with a concise result)
   and `reconcile`.

## Step 6 — freeze the candidate

Call `harness_freeze_candidate` with:

- `wu_id: "WU-P5-SMOKE-V1"`
- `base_paths: ["package.json", "src/resolve-binary.js"]`
- `overlay_paths: ["tests/harness-v1-smoke.test.js"]`
- `verification_contract`: the contents of
  `docs/phase-5-smoke/verification-contract.json`

Record the returned `candidate_id`, `manifest_hash`, `tree_hash`.

## Step 7 — deterministic verification

For each declared check (`smoke-behavior`, then `smoke-test`), call
`harness_run_verification` with the `candidate_id` and the check id. Expect PASS.
Record both `verify-<hash>` receipts. Do not edit or replace the contract.

## Step 8 — fresh independent review

1. `reserve` `dispatch_id: "review-smoke"`, `reserved_seconds: 300`.
2. `prepare_launch`; delegate to a **fresh** `harness-reviewer` session with the
   WU contract, candidate identity and the two receipts; it independently runs
   the declared checks and returns a verdict.
3. `record_launch` with the reviewer session id, then `record_finish`/`reconcile`.
4. `record_review`: `wu_id`, `candidate_id`, `verdict: "PASS"`,
   `reviewer: "harness-reviewer"`, and the verification receipt ids.
   PASS requires full coverage of all declared checks.

## Step 9 — complete the WU

`action: "complete_wu"` with `wu_id` and `candidate_id`. Record the completion
event id.

## Step 10 — evidence

Paste the following into `FINAL_RELEASE_REPORT.md` (section "Smoke-test evidence")
and commit on branch `phase-5-v1-finalization`:

```text
loaded revision:            <exact sha>
readiness:                  <ready true/false>
epic artifact / record_key: <...>
mandate id / revision:      <...>
WU:                         WU-P5-SMOKE-V1
candidate id:               <...>
manifest / tree hash:       <...>
verification receipts:      <smoke-behavior>, <smoke-test>
reviewer session / verdict: <...> / PASS
completion event:           <...>
notes:                      no failure injected; no repair/recovery used
```

## STOP conditions

- Loaded revision is not the frozen baseline.
- Readiness not ready.
- Any failure/rejection anywhere (do not retry, repair or recover — record it).
- Any check missing from the contract.
- Any file changed outside `tests/harness-v1-smoke.test.js`.
