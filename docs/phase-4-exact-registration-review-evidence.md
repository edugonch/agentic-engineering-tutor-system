# Exact-approved registration amendment — independent review

Candidate: `cand-e188a671e61228cc8e4cc47c2332d9041d7829a182c51f6fe32a9bd2a2efe789`.
Manifest hash: `c50e704235756ef648ba0b794270cbbace58bc1d7d5cbe9fc87b6b7d19d39d5a`.
Composed-tree hash: `17de64e7014454593062cdd16716f583e20d7c68429403dc15efc974eac3efa1`.
160 files. This reporting document was added after freeze and is not part of
the candidate being assessed; candidate source/tests/report remain unchanged.

Fresh reviewer session: `ses_f074b42b7ffenmjkr0Ffxy8Zc6` (`harness-reviewer`).
Final verdict: **DESIGN_SOUND — amendment PASS**, no confirmed in-scope findings;
safe to commit the bounded amendment under owner authorization.

The same reviewer continued an incomplete assessment twice: first its step limit
left inspection incomplete; then it requested commit-bound baseline evidence.
Neither interim BLOCKED result was interpreted as approval or hidden. Final PASS
followed inspection of the missing evidence against the unchanged candidate.
No implementation edits or candidate substitution occurred during review.

Independent checks, executed against this candidate and then receipts inspected:

| Check | Result | Receipt |
|---|---|---|
| exact-registration | PASS, 10/10 | `verify-7c727fc6143f0c4c4ee6098342775e6cd69dfb6f87f4a4b6c9028838da691ba5` |
| regression | PASS (implementer final suite: 275/275) | `verify-38a568748cfa069baf7cb1b6b6c0d1abcece5bb966e28daf9ca3aa810b3951a3` |
| validate | PASS, 73 paths | `verify-fc4e18ee49ddd42c413ade3949cd486d6ae7ec0fa784fb00d631231fb630f0dc` |
| entrypoint-syntax | PASS | `verify-1785423ee1d3e640a153da56ff9eab73675aa0817e00f2515e00e83f33b71bf8` |

Working-tree full suite: 275/275, zero failures/skips. Focused suite: 10/10.
Package validation: 73 paths. `git diff --check`: clean.

Commit-bound comparison used baseline
`0a9db5c6227a0e2157bbc6790ac506b6510f79b0`, Git tree
`864d749cb092c1439fef0c3adb1506c6abae77fb`, plus d385 implementation tree
`809b30f0b95d6983d9f42131e03876a44dd39975`. Tool-generated JSON records every
baseline blob SHA-256/mode, candidate identity, exact changed paths and source diff.
Evidence SHA-256:
`ef5be7bd5ced352f42c68b24d7ebae777461f5a869c4036a5154f9d382379e01`;
session scratch filename `exact-registration-baseline-comparison.json`.
Reviewer inspected this supplied evidence, not reviewer-executed Git commands.

Confirmed boundary: exactly the six files listed in the frozen amendment report,
no deletions or unrelated mode changes; this seventh file is post-review evidence.
No change to controller operations, repair/blocker/budget/dispatch semantics,
profiles, permissions or v1 packet. No predecessor review was reused as approval.

Publication-failure assessment is static: an unsuccessful index publication can
leave an immutable unindexed archive, but not newly usable indexed authority.
This review is not live registration or runtime proof. Risk remains Medium for
authority-sensitive registration. Installed plugin remains d385; no installation,
Epic registration, mandate creation or WU activation was performed.

Next authorized action: commit the amendment, prepare/publish v2 with updated
implementation/WU provenance bindings only, and stop for new owner review.
Normative runtime verification hash must stay
`f1d7ae2de6f5ca2ada64f1d62dedb9dddc32c27656fb839aedd350743f1e9753`.
Owner approval of v1 does not approve v2 or load its new implementation.
