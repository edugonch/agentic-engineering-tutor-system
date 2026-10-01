# Phase 4 bootstrap report

## Authority

Owner accepted FROZEN DESIGN CONTRACT v1 and explicitly authorized bootstrap
implementation in the current conversation. Contract SHA-256:
`82de3f16a69853871e567c592fe30b56f0c80706ef189b8f77682d7c1c794bda`.

This is OWNER_DIRECTED bootstrap infrastructure work, not a governed demonstration
WU and not authority to create/activate the proposed resolveBinary WU or its Epic.

Accepted baseline: `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`.
Implementation branch: `phase-4-bounded-repair`.

Owner implementation clarifications:

- No tooling recovery may widen permissions.
- WU attempt/cycle bounds and terminal blockers survive changing execution IDs.
- Recovery resumes/reconciles the same authorized attempt/dispatch after crash.
- Limits, lineage, immutable reviews and completion remain core invariants.
- Fault #8 means evidence/review bound to A cannot complete B.

## Status

PHASE_4_CONTRACT_GATE = PASS
PHASE_4_BOOTSTRAP = AUTHORIZED
PHASE_4_IMPLEMENTATION = CHANGES_REQUIRED
PHASE_4_BOOTSTRAP_REVIEW = CHANGES_REQUIRED
PHASE_4_RUNTIME_PROOF = PENDING
PHASE_4 = UNVERIFIED

Readiness before delegation: real `harness_check_agent_readiness` returned ready
for harness-builder and harness-reviewer; installed profiles unchanged.

## Evidence

Current successor bootstrap tree: `npm test` **265/265 PASS**, zero failures/skips;
`node --test tests/execution/phase4.test.js` **24/24 PASS**, zero failures/skips;
`npm run validate` **PASS (73 paths)**; `git diff --check` **PASS**;
These fresh runs include the permission persistence, composed-tree scope,
ambiguous-launch fixes and the four accepted independent-review corrections.
Earlier 254/254 and 261/261 results are not evidence for this tree.
Baseline's 241 tests remain regression reference only.

Logs retained in the session scratch directory:
`/private/var/folders/0t/gyfpf68s3t139pvmmqr6fcww0000gn/T/opencode/phase4-final-regression.log`
and `phase4-final-faults.log` in the same directory.

No implementation commit exists. HEAD remains
`dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`, branch `phase-4-bounded-repair`.
Last established loaded plugin SHA remains that accepted baseline; the new
working tree has not been loaded as an OpenCode plugin revision.

## Bootstrap dispatch blocker

Builder session `ses_f0aa80528ffegBF0OHrZCDTzTS` rejected the OWNER_DIRECTED
bootstrap assignment before reading/changing implementation or running checks.
Its governing profile requires exactly one explicitly activated WU belonging to
an Epic, with an approved budget. It cannot accept the explicitly non-WU
bootstrap authorization under that profile.

At the time of that refusal, no implementation files changed. No Epic/WU was created or activated. No alternate
agent or permission/profile change was used to bypass the rejection. The accepted
design remains unchanged. Owner resolution is required for the bootstrap executor;
this is separate from approval of the later governed runtime demonstration.

Owner subsequently explicitly authorized direct implementation in the primary
session, accepted the builder refusal as correct, and prohibited profile or
permission changes. This resolves only bootstrap executor authority. It is not a
governed controller operation or blocker resolution. No agent profiles will change.

The earlier 40-tool-call circuit breaker interrupted this owner-directed bootstrap.
It is not a Phase 4 governed blocker and created no controller authority or event.

## Exact changed-file inventory

Modified:

- `index.js`: schemas, caller identity, runtime tool/permission/event hooks.
- `scripts/validate-package.mjs`: includes five new implementation/test paths.
- `src/execution/constants.js`: three new semantic operations.
- `src/execution/controller-tool.js`: repair/recovery actions, evidence, summaries.
- `src/execution/execution.js`: ownership serialization, permission admission/reconciliation.
- `src/execution/index.js`: runtime guard export.
- `src/execution/state.js`: versioned policy projection integration.
- `src/project-knowledge.js`: structured approved envelope parsing.

Added:

- `src/execution/ownership.js`: project-wide WU/mandate ownership from logs.
- `src/execution/permission-stops.js`: durable denial facts and restricted admission.
- `src/execution/repair-policy.js`: limits, lineage, immutable reviews, blocker transitions.
- `src/execution/runtime-guard.js`: bound dispatch admission and denial observations.
- `tests/execution/phase4.test.js`: twenty-four automated scenarios.
- `docs/phase-4-bootstrap-report.md`: this evidence report.
- `docs/phase-4-bounded-repair-and-blocker-resolution.md`: previously accepted contract,
  newly tracked relative to baseline but byte-for-byte unchanged during bootstrap.
- `docs/superpowers/plans/2026-09-30-phase-4-bootstrap.md`: bootstrap plan.

No profiles, permissions, or runtime demonstration governance records were edited.
Approved Epics/WUs appearing in automated tests exist only in disposable fixtures.

## Permission persistence race

Before acquiring a lease to append `BLOCK`, a runtime rejection writes a
content-addressed fact into `permission-stops.json`, under the controller/project
mutexes using durable atomic write. Its identity binds WU, mandate revision,
origin session and denial evidence. It grants no execution authority. Re-observing
the same fact is idempotent. Facts are retained after reconciliation.

Controller admission and runtime guards consult the fact even when no BLOCK event
exists yet. Status/recover expose the effective terminal stop and pending facts;
the event projection remains separate and is never silently rewritten. A valid
lease holder uses `reconcile` without a dispatch ID to append the deterministic
BLOCK operation with fencing and CAS. Lease/revision conflict defers that append,
never the stop. Audit and settlement remain possible. Fresh-process tests cover
lease conflict, CAS conflict, repeated observation, single BLOCK reconciliation,
cross-controller escape rejection and no denied side effect.

## Frozen-contract mapping

| Contract | Implementation and automated evidence |
|---|---|
| §§1–2 baseline, bounded bootstrap | Exact baseline above; no runtime authority created; contract hash rechecked |
| §§4–5 approved envelope, one repair | `project-knowledge.js`, `validateRepairPolicy`, `REPAIR_AUTHORIZE`; fixture authority/limit/replay tests |
| §6 current candidate, immutable review and lineage | `beforeRepairEvent`/`afterRepairEvent`; #1–5, #7–8; composed-tree comparison includes approved base identities |
| §6 fresh independent sessions/evidence | typed REVIEW dispatch, session uniqueness, candidate-bound receipts within dispatch; #1–4, #7–8; live specialist identity remains runtime-only |
| §7 cumulative funding, reservation, uniqueness | policy reservation gates and existing reconciliation; #6 plus zero-cost, semantic-slot, held-reservation and ambiguous-launch tests |
| §8 typed recovery and sticky hard stops | policy action descriptors, WU-level per-class attempts, observed action evidence, resolution receipts; #9–11, #13 |
| §8 permission denial despite persistence race | write-ahead permission facts, effective blocker, core admission and fenced reconciliation; dedicated lease/CAS fresh-process tests |
| §9 durable versus orchestration responsibilities | counters/lineage/dispatch restrictions in core; runtime guard and findings packet in state; semantic correction judgment still requires independent/runtime review |
| §§10–11 real WU and acceptance | RUNTIME PROOF PENDING; proposed resolver Epic, envelope and intentional injection remain unapproved |
| §12 compatibility and fault cases | matrix below; accepted Phase 3 projection comparison |
| §13 release gate | UNVERIFIED until independent review and separately authorized runtime proof |

## Fault-injection matrix

All automated results below refer to `tests/execution/phase4.test.js`. Every row
still has **RUNTIME PROOF PENDING**; automated fixtures are not runtime acceptance.

| # | Fault and test scenario | Automated result | Runtime |
|---|---|---|---|
| 1 | Restart after CHANGES_REQUIRED; findings retained (`#1-4`) | AUTOMATED PASS | RUNTIME PROOF PENDING |
| 2 | Restart after settled repair before B freeze (`#1-4`) | AUTOMATED PASS | RUNTIME PROOF PENDING |
| 3 | Crash/reload after B before review (`#1-4`) | AUTOMATED PASS | RUNTIME PROOF PENDING |
| 4 | Identical repair replay, changed-payload conflict (`#1-4`) | AUTOMATED PASS | RUNTIME PROOF PENDING |
| 5 | Second repair, including distinct findings (`#5,11`, `distinct findings`) | AUTOMATED PASS | RUNTIME PROOF PENDING |
| 6 | Unfunded authorization and expiry during live repair (`#6`, `#6 during repair`) | AUTOMATED PASS | RUNTIME PROOF PENDING |
| 7 | Core review overwrite/fake fresh PASS (`#7,8`) | AUTOMATED PASS | RUNTIME PROOF PENDING |
| 8 | A evidence rejected for B; superseded A cannot close WU (`#7,8`) | AUTOMATED PASS | RUNTIME PROOF PENDING |
| 9 | All six terminal classes reject repair/downgrade/closure/new controller (`#9`) | AUTOMATED PASS | RUNTIME PROOF PENDING |
| 10 | Recovery restart resumes one attempt; new blocker/dispatch cannot replenish (`#10`) | AUTOMATED PASS | RUNTIME PROOF PENDING |
| 11 | Identical unresolved finding yields NO_PROGRESS (`#5,11`) | AUTOMATED PASS | RUNTIME PROOF PENDING |
| 12 | Stale fencing token cannot authorize repair (`#12`) | AUTOMATED PASS | RUNTIME PROOF PENDING |
| 13 | Descendant rejection, restart/alternate routes and lease/CAS race (`#13` scenarios) | AUTOMATED PASS | RUNTIME PROOF PENDING |

Additional negative cases:

| Case | Automated result | Runtime |
|---|---|---|
| Out-of-scope successor and initial base-snapshot smuggling | AUTOMATED PASS | RUNTIME PROOF PENDING |
| Verification-contract replacement | AUTOMATED PASS | RUNTIME PROOF PENDING |
| Zero-cost external dispatch | AUTOMATED PASS | RUNTIME PROOF PENDING |
| Mandate/budget replacement and alternate execution ID | AUTOMATED PASS | RUNTIME PROOF PENDING |
| Semantic duplicate dispatch and ambiguous launch release | AUTOMATED PASS | RUNTIME PROOF PENDING |
| Missing recovery action/evidence and non-approved recovery tool | AUTOMATED PASS | RUNTIME PROOF PENDING |
| Replay compatibility with accepted Phase 3 | AUTOMATED PASS | Historical replay only; new runtime proof pending |

Phase 3 comparison used the accepted cached baseline projection against current
projection on ten local P3 controller directories. `P3B-WU01` (10 events) remains
identical and completed. P3A2/3/4/5 logs and empty negative directories match.
`P3A-SMOKE` and `P3A1-SMOKE` are old invalid smoke records: both implementations
reject them identically for PASS without verification evidence. They are not newly
accepted logs. The initial all-valid replay command exposed these historical
rejections; the comparison explicitly checks matching outcomes rather than
rewriting history. Frozen contract SHA-256 remains
`82de3f16a69853871e567c592fe30b56f0c80706ef189b8f77682d7c1c794bda`.

## Independent review and remaining debt

This report is the pre-review evidence packet. Freeze the exact implementation,
contract, tests and report into the content-addressed candidate registry without
a synthetic WU/source-WU identity. Record its identity and independent reviewer
verdict separately so the reviewed report itself stays immutable. No PASS from
this implementation session counts as independent review.

Still pending: independent assessment; live loaded revision; real builder A,
CHANGES_REQUIRED reviewer, repair B, fresh reviewer PASS and WU_COMPLETE;
real tooling restoration and denied-operation scenarios; real specialist handoff
and launch/restart timing evidence. Approved architecture/external-fact recovery
descriptors have policy guards but no real scenario proof yet. Full cryptographic
reviewer identity and existing process/network containment remain explicit debt.

The recommended Phase 5 baseline remains the accepted Phase 3 SHA. Neither the
green automated suite nor a bootstrap review can promote Phase 4 to PASS.

## Independent review outcome — first frozen bootstrap candidate

Candidate `cand-e27497fc1e73cbc047ea05ee924e80252e6c2c83d850f725b99b663d311f57bc`
contains 153 files and deliberately has no source-WU identity. Manifest hash:
`300e23a0b59c77340d3bea4ffa69c752f5dfe8a846f882bef189359eb06491dd`.
Composed tree hash:
`45b3f815ad85c9dee2db20a05116246b5ba099c05cd632d47ed5587c63aa05f4`.

Fresh `harness-reviewer` session `ses_f0a8ac27cffeAbkKKzAGbkcEtb` independently
reviewed its frozen blobs as a bounded architecture/implementation challenge.
Verdict: **DESIGN_CONCERNS**, risk HIGH. No governed WU review or owner approval
was fabricated. Reviewer ran all four declared candidate checks:
regression 261/261 PASS, phase4-faults 20/20 PASS, validate 73 paths PASS,
entrypoint-syntax PASS. Regression receipt:
`verify-cab76e9da1f34d213fb334e6e5092ac92901fe886da0d75421e4529e365e60c6`.

Confirmed high-severity correction requirements:

1. `runtime-guard.js:116–152`: controller-side consequential tools can run without
   a reservation; narrow diagnostics/settlement and require funded execution.
2. `repair-policy.js:126–130,160–171`, `state.js:316–319`: a new recoverable BLOCK
   can replace an unresolved blocker; reject replacement except terminal escalation.
3. `runtime-guard.js:137–142,167–184`: exact recovery action can repeat within one
   dispatch, after failure or ambiguous outcome; persist one action claim before
   its side effect and retain success/failure/ambiguity without automatic retry.
4. `ownership.js:13–26`, `runtime-guard.js:33–35,96–99`: invalid historical smoke
   logs poison all runtime admission before Phase 4 filtering; isolate historical
   errors without ignoring corrupt relevant governed authority.

These counterexamples were identified by static review; their new execution
checks were not in the frozen verification contract. Targeted regression tests
and corrections require a new candidate and fresh review. The original frozen
candidate and its receipts remain retained. This appended outcome is subsequent
reporting, not part of that candidate. Runtime acceptance remains pending.

## Successor repair packet — four accepted findings only

Owner accepted R1–R4 as the complete bootstrap correction packet. Before any
further source edits, the four previously added focused tests were executed:
**0 PASS / 4 FAIL / 20 intentionally skipped**. Each failure reproduced its
corresponding accepted finding. After correction the same focused selection
reported **4 PASS / 0 FAIL / 20 intentionally skipped**.

| Finding | Minimum correction | Regression evidence |
|---|---|---|
| R1 unreserved controller effects | `runtime-guard.js`: controller-side tool admission permits named read-only diagnostics and candidate-freeze bookkeeping after settled handoff; other execution requires funded authorized dispatch. Existing controller audit/settlement calls remain possible. | `P4 review R1`: shell/patch/webfetch/execute denied before build and after rejected review; read/status allowed; cumulative budget retained |
| R2 blocker substitution | `repair-policy.js`: a live unresolved blocker rejects replacement by any recoverable class. Terminal escalation remains allowed and both historical records are retained; terminal downgrade remains forbidden. | `P4 review R2`: three replacement classes rejected, fresh-process original blocker survives, permission escalation retains both records |
| R3 repeated recovery action | `repair-policy.js` and `runtime-guard.js`: durable single-use CHECKPOINT action claim precedes tool execution; its tool-call identity binds one success/failure outcome. Exact operation replay is bookkeeping only, never permission to repeat the external action. Missing outcome remains ambiguous and prevents retry/verification; failed outcome persists NO_PROGRESS. Permission facts also forbid action claims. | `P4 review R3`: crash, failure and success all reject same-ID and new-ID re-execution after restart; failed attempt stops; unconfirmed action cannot obtain diagnostic accreditation. Existing successful recovery test now records the before-hook claim. |
| R4 invalid legacy isolation | `ownership.js`: structurally valid pre-Phase-4 logs that fail projection are exposed with `projection_error` and historical identity bindings, not projected as valid state. Runtime guard rejects affected identities; ownership rejects overlapping WU/mandate/artifact identities. Unrelated execution remains usable. Malformed logs, Phase-4 policy logs and denial-fact integrity errors still fail closed. | `P4 review R4`: unrelated admission and valid checkpoint survive invalid historical dispatch; inventory exposes error; old session/explicit execution remain blocked; corrupt Phase-4 history remains fail-closed |

No existing historical log was rewritten. The earlier immutable candidate and
its DESIGN_CONCERNS review remain preserved and do not accredit this successor.
The implementation changes in this cycle are limited to `repair-policy.js`,
`runtime-guard.js`, `ownership.js`, `permission-stops.js`, the focused test file
and this report. Complete verification of this tree: **265/265** repository tests,
**24/24** Phase 4 tests, **73** validation paths and clean `git diff --check`.

A new candidate must bind this report and corrected tree, receive freshly
executed candidate receipts and a fresh independent review. Its identity and
verdict will be recorded in a separate post-freeze evidence document. No new
commit, plugin reload, governed Epic/WU or runtime acceptance is implied.

## Successor review and focused R4 observation correction

Second immutable candidate:
`cand-c97318eda0f99253bcaa812de2aecd42b5be0163a73f979bf538a26eeccb8ec8`.
Manifest: `908712e66e5cc99e6c0a7e80d0f7e4e70d68f12ab268196162f5181bfdbc66a3`.
Tree: `e2c5aab8fcfbc7c97abd2bbe455d5121d45e9fb87f213fd2cf53e4966ef4d270`.
Fresh candidate checks passed: 265/265 regression, 24/24 Phase 4, validation 73,
entrypoint syntax. Receipts respectively:

- `verify-088823a66b2096de7203dcdb672a0bbdcdda495ed29b647e1c9185aa042fff16`
- `verify-b40bd4a0ad8f125082604aa6765161d3bf59d405842e4c3d7e67042d30515486`
- `verify-8fbe8302997d934253edf937d4bde8a060777454f0dc5f8a64348c0ba07cd048`
- `verify-b5176a2c691a65372a115379af8924c9ee89e439a07b83fcaabefc63ba3710b0`

Fresh reviewer `ses_f0a77c374ffewo4c1UDSjvpoyT` inspected these receipts and frozen
blobs without rerunning checks. Verdict **DESIGN_CONCERNS**: R1–R3 satisfied;
R4 ordinary admission was isolated, but a permission observation for an invalid
historical session rejected the shared observation chain and could terminate
event subscription, blocking unrelated valid sessions.

The R4 fixture was extended with both a permission-evaluation denial and a
`permission.replied` rejection for the invalid old session, then unrelated
admission, valid bookkeeping and a later valid permission rejection. It first
failed with the exact historical-projection exception. The minimal correction
in `rejectPermission` leaves known invalid pre-Phase-4 records quarantined and
visible in inventory without rejecting the shared observation chain. Their
affected identities still fail closed in `beforeTool`; no event is rewritten or
projected as valid. Corrupt Phase-4 authority still fails closed during inventory.

Final focused rerun: **4 PASS / 0 FAIL / 20 intentional skips**. Final complete
Phase 4: **24/24 PASS**, no skips. Final repository: **265/265 PASS**, no skips.
Package validation: **73 paths PASS**. `git diff --check`: **PASS**.
The prior successor candidate and its review remain immutable; these last
changes require another fresh frozen candidate and independent assessment.
Final post-freeze identity, receipts and verdict are to be recorded separately in
`docs/phase-4-bootstrap-review-evidence.md`, preserving the reviewed report bytes.
