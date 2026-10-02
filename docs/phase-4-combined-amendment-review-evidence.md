# Phase 4 combined amendment — independent-review evidence

This post-freeze record reports the independent assessment of one immutable
candidate. It is not part of that candidate and does not modify it.

## Scope

One combined amendment, containing only:

1. **Emergency cap change** — `HARNESS_MAX_TOOL_CALLS` default `40 → 250`,
   `HARNESS_MAX_DELEGATIONS` default `3 → 16`. These remain emergency runaway
   fuses, never durable budgets or grants of authority; funded dispatch,
   repair/recovery limits and NO_PROGRESS semantics are unchanged.
2. **Controller transport fix** — structural Code Mode extraction of the exact
   real specialist wrapper plus a control-branch denial of any non-owner
   mutating controller action before tool execution and lease acquisition.

## Exact immutable candidate

- Candidate: `cand-13698b4ef2770af293ac5e3e50e6fbe3cb8b5b23b724301c432cf253f081d741`
- Manifest hash: `a6701095aea34177ce04a58d5ef231522c49ca98312b0c66c274385769ae1580`
- Composed-tree hash: `2cbca948e22f881f444654fd97024c5b9de9b504a30d1a2bcf75d6dea4a0595b`
- Normative verification-contract hash: `0f743437473532e6cd124107fb808e3bc06c805a065ed8353eb457ad14b8b59f`
- 163 captured paths; source-WU identity deliberately local `WU-P4-COMBINED-AMENDMENT-002`.

## Declared checks and durable receipts

Run through `harness_run_verification` against the exact frozen candidate:

| Check | Result | Orchestrator receipt |
|---|---|---|
| `controller-transport` | PASS, 24/24 | `verify-831727d140b2705d846131db7af03c5b728f719dc17920b6c820e637790bbec1` |
| `turn-guard` | PASS, 9/9 | `verify-002d3deb3eb8c38fa156f043102319c84046abc4714d978d2c6c310dab37b9b4` |
| `phase4` | PASS, 31/31 | `verify-bf83d84689306e09d5dd6f054f304b76daeafa3a737f20cbf32f1b9bf6819215` |
| `regression` | PASS, 308/308 | `verify-57f64d312bfb41c8b25d08004e15d07da11b20a4fa8b27fcdf52f969e318f383` |
| `validate` | PASS, 73 paths | `verify-6153b89839652506023ba82dea2a9ffcdaacc43d7da227b75eab5f81d7c5ea15` |
| `entrypoint-syntax` | PASS | `verify-7aeaa046ea08cef2772dc73df0d52c7427eca41548ae2a8ea01f6321982a953e` |

Working-tree evidence before freeze: repository `308/308 PASS`, Phase 4 `31/31 PASS`,
focused transport `24/24`, turn-guard `9/9`, `npm run validate` `73 paths PASS`,
`git diff --check` clean.

## Live runtime proof

One disposable live canary was run from a separate top-level session that created
governed state and launched a real `harness-builder` child. The child sent the
exact observed Code Mode wrapper:

```js
return await tools.harness_execution_controller({
  action: "checkpoint",
  execution_id: "P4-TRANSPORT-CANARY-006",
  checkpoint_id: "specialist-mutation-canary"
})
```

The child was rejected with exactly `Specialist cannot mutate execution authority.`
(the required gate text), before any controller commit or lease acquisition. The
durable record contains no specialist `CHECKPOINT`; revision, lease holder and
fencing token were unchanged. `CONTROLLER_TRANSPORT_RUNTIME = PASS`.

## Fresh independent assessment

- Reviewer: `harness-reviewer`, fresh session `ses_f02583e40ffev5mHaow50nGFHt`.
- Verdict: **PASS** for this exact candidate.
- Independently re-ran all six declared checks and recorded receipts:
  `controller-transport` `verify-7c85046dad1847ba26b2dbb25991b1c70189b2772c3962d67ceaeb71537d223a`,
  `turn-guard` `verify-0dcf62935c12b560c7c89d3712a6dee3f3f49071a41c541d121b25f621c687fa`,
  `phase4` `verify-ed19c5374a1e1f12b495609d160b558b2e936d4b1297a3fb9cf92f12dff3ff43`,
  `regression` `verify-8a9ef2e778ac2c85fdf1b1d9eef55bc8e740748d4c9a00960417bffeb98989db`,
  `validate` `verify-06b81907ee65c7c9eb295ba27f7170122fe122797876cb932b340002e5ebb9c2`,
  `entrypoint-syntax` `verify-dc33fa69bec4958620784b8d16ce16d5bb6857b8266197e3315651f4ae435864`.
- Confirmed: the amended control predicate denies a non-owner descendant on any
  non-read controller action regardless of whether its dispatch binding is yet
  visible; owner bookkeeping and controller read/recovery actions remain admitted;
  `recover` is correctly classified read-only.
- No blocking finding. Q1 (a non-normalized wrapper is treated as generic
  `execute` and remains bounded by lease acquisition) is a pre-existing,
  explicitly out-of-scope limitation under the instruction not to add raw
  substring matching or further hardening; recorded here for the owner, not
  introduced by this amendment.

The reviewer states explicitly that this is an independent challenge, not owner
approval or Phase 4 runtime acceptance. Risk remains HIGH because this code governs
execution authority.

## Q1 authority-boundary correction (revision 2 of the combined amendment)

The first independent review recorded Q1 as an out-of-scope limitation: a Code
Mode wrapper not structurally recognized by `extractControllerInvocation` was
treated as generic `execute`, so only lease ownership stopped it. Because the
execution lease can expire while a specialist dispatch is still authorized, that
was a real authority bypass. Owner gate review returned
`PACKET_V3_GATE = CHANGES_REQUIRED`.

Correction: the specialist-mutation predicate is factored into one shared helper
(`src/execution/controller-authority.js`) used by both the runtime guard (early
admission) and the actual `harness_execution_controller` tool boundary
(`assertToolControllerAuthority` in `src/execution/controller-tool.js`, called from
`index.js` before `runExecutionController`). Any wrapper, alias or Code Mode
variation that reaches the real tool is denied before `runExecutionController` and
before any lease acquisition, independent of outer syntax. Read-only actions
(`status`, `recover`, `verify`) retain their semantics, and owner bookkeeping is
unaffected. No dispatch semantics, repair-policy behavior, generic-`execute`
privilege or emergency-cap behavior changed.

- Candidate: `cand-9f7dc2229ebb261b695c3093a09a55dce6a4e8fad104db5122fb0da1437c514c`
- Manifest hash: `3282879d2a0f7f796e473f87289290eeb1d95089d2aeea5d68bf4f6365b15c3f`
- Composed-tree hash: `13fe0e2f94eb94008c850ed7971b30398367daa3c6b7cec303afe7ad4c9bf79c`
- Normative verification-contract hash: `0f743437473532e6cd124107fb808e3bc06c805a065ed8353eb457ad14b8b59f`
- Declared checks all PASS. Orchestrator receipts: `controller-transport`
  `verify-cc8efd7071e25c6f256f2ddd140ad1f6158966ecfccc334beaf2cd6f38f2f915`,
  `turn-guard` `verify-df6db2042390461bd79d6acd47d96c93ae901e5feb5ac60b45da9a7e8ac7cc46`,
  `phase4` `verify-de3066d05970f1e21869f367ed4b780988d7a96ed1d48402c21ee75211e036ac`,
  `regression` `verify-fccba58b695b469504b896f7cee1f8fd5e2d7a189931b3ad3d01652543610614`,
  `validate` `verify-12ca2a28687b43fda38b9c7fcf55b54b124e4211ecec905e37fd8ee20da39781`,
  `entrypoint-syntax` `verify-618f619cf06c73b61a569d5895767ee27909e8cebd0dfd7bb081bbf1d9d6425e`.
- Fresh independent `harness-reviewer` session `ses_f0237a798ffeaay3rcL5NOmcb0`:
  **PASS**, all six checks re-run. It confirmed the backstop is at the real tool
  boundary, the predicate is a single shared model, denial precedes acquire even
  with an expired lease, and the Q1 tests assert revision, lease holder and
  fencing token unchanged. No blocking finding; only LOW scope/operational notes
  (repair-policy-scoped binding, pinned-session restart lockout, boundary call
  covered by inspection rather than a behavioral test, and a theoretical TOCTOU).

