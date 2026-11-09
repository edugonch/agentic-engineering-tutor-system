# Solo Developer delivery — one small-clinic owner, CI-first execution

The Harness formerly required **both** a full, often long local frozen verification run and an independent LLM reviewer before every WU merge, even for pure single-purpose functions. That architecture left ALFRAN E05-27-E blocked after GitHub had already run every check successfully: the local `jit-test` hit a 300-second limit, and the reviewer provider returned HTTP 400 before the first tool call.

## What changes

For an existing owner-approved Epic, the owner may adopt **once**, via an indexed and hash-verified APPROVED decision, a delivery policy for *explicitly named low-risk WUs*. It does not convert all unknown work into low risk. The optional decision requires exactly one typed line:

```text
solo_delivery: {"execution_id":"alfran-epic05-delivery","mandate_id":"<EXACT_DURABLE_MANDATE_ID>","mode":"SOLO_CI","eligible_wu_ids":["E05-27-E"],"ci_check":"verify"}
```

Replace the mandate ID with the actual `status.mandate.mandate_id`. For future low-risk WUs, list all the approved low-risk WU IDs **in this one decision** when first adopting the policy (not a new approval on every WU). Do not include a WU that needs mandatory security, authentication, payments, clinical, schema/migration or concurrency review without the owner's explicit risk decision. Unknown or unlisted WUs retain strict review. A single-Epic policy cannot authorize another Epic or enlarge the WU sequence or budget.

After the owner has approved and the decision has been recorded with the normal knowledge/index mechanism, invoke:

```text
harness_execution_controller(
  action="adopt_solo_delivery",
  execution_id="<EXACT_EXECUTION_ID>",
  decision_artifact_id="<EXACT_APPROVED_DECISION_ID>",
  response_mode="compact"
)
```

The controller pins the policy source hash immutably. There is no `owner_confirmed: true` input to bypass approval.

## Normal low-risk WU loop (no LLM reviewer)

1. Implement and freeze one candidate with only the approved WU scope. Record the candidate. If the implementation already exists, **reuse it**; do not launch another builder just to create receipts.
2. Run the one GitHub Actions CI check explicitly named by the approved policy against the exact PR head. The approved CI route replaces a duplicate local full-suite run and mandatory model review **only** for this named low-risk WU. It never changes an old receipt into PASS or rewrites the frozen WU verification contract.
3. Bind the candidate and exact PR `head_sha`/`base_sha` through the existing controller; then call `harness_merge_candidate(candidate_id)`. The merge tool reads the actual GitHub PR/checks, compares the immutable candidate tree with the PR, and requires live CI SUCCESS. On success it appends a distinct `SOLO_CI_ACCEPT` event with the candidate tree/manifest hashes, policy SHA, CI check name, exact head and remote evidence. This is **not** `RECORD_REVIEW:PASS`.
4. The existing guarded merge proceeds with all original GitHub, dispatch, process, blocker, CI and permission gates. After remote merge verification, `complete_wu` closes the WU, recording the acceptance basis `SOLO_CI`.
5. Continue the next already-declared WU. Batching, when previously owner-authorized, still requires its original independent review unless a separately implemented batch-specific trust policy exists; this initial policy deliberately covers individual low-risk WUs only.

## What remains non-negotiable

- All mutations use the durable controller CAS/lease/fence; no fake model review, no invented test receipts, no rewrite of `events.ndjson` or budget.
- Owner-selected WU ID, the approved mandate and process obligations must match. Existing process-red/recovery obligations remain in effect. Existing independent `CHANGES_REQUIRED` findings cannot be ignored.
- Unsettled launches or active verification, a blocker, changed PR head/base/tree or non-success CI prevent the solo acceptance and merge.
- No production deployment, database/clinical actions, permission changes, scope expansion, unapproved WU or newly created budget.

## ALFRAN E05-27-E continuation

The PR is [ALFRAN #246](https://github.com/edugonch/alfran-web-platform/pull/246), and GitHub workflow `verify` finished successfully on head `f1bae33e8925704b3b61ffd5c22e4f182f56e331`. With a correctly approved and adopted solo policy covering E05-27-E, no third reviewer with unchanged HTTP 400 or duplicate local 300-second `jit-test` is required. The local OpenCode controller still must bind the *actual recorded candidate* and exact PR/CI, pass any remaining process gates, execute the governed merge and record `complete_wu`. GitHub merge alone cannot mutate that local journal.
