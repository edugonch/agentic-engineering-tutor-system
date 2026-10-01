# Phase 4 bootstrap — final independent-review evidence

This post-freeze record reports the independent assessment of one immutable
bootstrap candidate. It supplements `docs/phase-4-bootstrap-report.md`; it is not
part of the candidate it describes and does not modify that candidate's report.
The CHANGES_REQUIRED statuses inside the frozen report are its pre-review state.

## Current gate state

```text
PHASE_4_CONTRACT_GATE = PASS
PHASE_4_BOOTSTRAP = AUTHORIZED
PHASE_4_IMPLEMENTATION = PASS (bounded bootstrap repair packet R1–R4)
PHASE_4_BOOTSTRAP_REVIEW = PASS (independent DESIGN_SOUND / repair packet PASS)
PHASE_4_RUNTIME_PROOF = PENDING
PHASE_4 = UNVERIFIED
```

Stop at this boundary. No demonstration Epic/WU was created or activated; no
runtime mandate was synthesized. No merge, deployment, baseline promotion or
plugin reload is implied. The tool-call circuit-breaker interruptions were
bootstrap interruptions, never governed Phase 4 blocker events.

## Exact immutable candidate

- Candidate: `cand-e02d28468349da2fe8f830e3a35869add05b491ab744463bc3cb2a0991412bcf`
- Manifest hash: `9fefd0f77186e9722166240b8f9bcf3b72fd2844df02e9632577e1226cedc354`
- Composed-tree hash: `d0a872dbfd4ce9ea067d661ed539d77f04da5a205555065eec97b97177368d13`
- 153 captured files; source-WU identity deliberately null.
- Registry: `.harness/execution/candidates/<candidate_id>.json` and immutable
  `.harness/execution/candidate-blobs/`.
- Branch: `phase-4-bounded-repair`.
- HEAD/baseline: `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`.
- No bootstrap implementation commit was made; changes remain uncommitted.
- Last established loaded plugin SHA is the accepted baseline above. This
  successor source tree has not been loaded/proven as an OpenCode plugin revision.
- Frozen design contract SHA-256, rechecked unchanged:
  `82de3f16a69853871e567c592fe30b56f0c80706ef189b8f77682d7c1c794bda`.

The exact changed-file inventory and all thirteen fault-injection mappings are
in the frozen bootstrap report. This post-freeze evidence document is the only
additional file beyond that inventory; it changes no implementation or tests.
Agent profiles and permissions remain unchanged.

## Fresh verification for this candidate

The final working tree passed 265/265 repository tests, 24/24 Phase 4 tests,
package validation (73 paths), and `git diff --check`. The four accepted finding
tests were first RED, then GREEN; the R4 observation extension also reproduced
its failure before correction. Complete suites had no failures or skips.

All four declared checks were then freshly executed through
`harness_run_verification` against this exact frozen candidate:

| Check | Result | Durable receipt |
|---|---|---|
| `phase4-faults` | PASS, 24/24 | `verify-e38fc12d3b3cc36db6e4f8c42a7c984301c49462dc29f04e55f82539aac68fdd` |
| `regression` | PASS, 265/265 | `verify-105c429bd4cd96f105603165d7cefce4b5aef375143627f5f0710723ba9a5416` |
| `validate` | PASS, 73 paths | `verify-03637b00d98bce01b8347e9a2ec0ad69a67b6c43b3e897d07aa0ac30d4f326a0` |
| `entrypoint-syntax` | PASS | `verify-c9ee9c8896a779fce48f55865a900dbbf4c73c97a7e18faa71f7563e46057110` |

## Fresh independent assessment

- Reviewer: `harness-reviewer`, fresh session `ses_f0a738962ffeyPKnJqh2PX2bt9`.
- Verdict: **DESIGN_SOUND — repair packet PASS**.
- Mode: bounded consequential architecture/implementation challenge under the
  unchanged reviewer profile, not fabricated governed WU accreditation.
- Scope: only the owner-accepted R1–R4 repair packet and adjacent invariants.
- Finding result: **no confirmed remaining findings within R1–R4**.
- Independently reran `phase4-faults`: **24/24 PASS**, zero failures/skips.
- Independent receipt:
  `verify-6c8f1f5b6324f3a2c9d95e5a72351f1c87bb7c8306f3fb9b2e70e4dd6e130174`.
- Inspected all four supplied candidate-bound receipts and their identities.
  Did not rerun regression, validation or syntax.
- No edits, arbitrary commands, undeclared checks or delegation by reviewer.

Accepted findings assessed independently:

| Finding | Final assessment |
|---|---|
| R1 positive reservation before consequential controller execution | PASS; named diagnostics/bookkeeping preserved |
| R2 unresolved blocker substitution | PASS; replacement rejected, terminal escalation retains history |
| R3 repeated recovery action | PASS; durable single-use claim, failure stop and ambiguous-outcome admission denial |
| R4 invalid historical reconstruction and permission observations | PASS; affected identity remains fail-closed while unrelated observation/admission continues |

The reviewer explicitly states this is an independent challenge, not owner
approval or Phase 4 runtime acceptance. Risk remains HIGH because this code
governs execution authority and permission stops.

## Preserved predecessor evidence

Both prior candidates remain immutable and loadable:

- `cand-e27497fc1e73cbc047ea05ee924e80252e6c2c83d850f725b99b663d311f57bc`:
  original DESIGN_CONCERNS, 261/261 and 20/20 evidence only for that candidate.
- `cand-c97318eda0f99253bcaa812de2aecd42b5be0163a73f979bf538a26eeccb8ec8`:
  successor DESIGN_CONCERNS identifying the remaining R4 observation path.

Neither earlier verdict was relabeled, overwritten or reused as approval of the
final candidate. Each modified implementation was frozen and verified separately.

## Runtime-only requirements and stop

Real loaded-plugin operation, specialist builder A → CHANGES_REQUIRED review →
repair B → fresh review PASS → WU_COMPLETE, live restart timing, actual permission
event delivery and bounded tooling restoration remain **RUNTIME PROOF PENDING**.
All thirteen automated fault cases remain **AUTOMATED PASS / RUNTIME PROOF
PENDING** as mapped in the bootstrap report. Automated fixtures and this review
do not create authority for the proposed demonstration Epic or its injection.

Keep the accepted Phase 3 SHA as the recommended baseline. Further runtime work
requires the separately explicit owner-approved Epic authority and a verified
loaded bootstrap revision. Stop here as instructed by the owner.
