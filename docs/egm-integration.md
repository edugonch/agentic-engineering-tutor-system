# Optional EGM design reviews for the OpenCode V2 Harness

Status: **EXPERIMENTAL / enabled by default, invoked on demand**. This is a *selective adapter*, not Google's complete Elephant-Goldfish Model workflow or an assertion of native OpenCode V2 support by Google.

## Provenance and distribution

Upstream: https://github.com/google/elephant-goldfish-model

Pinned revision: `5382b17619be07811a14b2146c7672620b34a791`

Three **unaltered** original EGM reviewer personas, three unaltered standards and the upstream Apache-2.0 license are checked in under `docs/egm/upstream/`. The Harness adapts them **at installation time** into V2 subagent profiles. The generated profiles carry attribution, modified Harness instructions and V2 tool permissions. Source material is independently attributable; changes to the adapter do not change the archived originals.

The complete EGM skill set, orchestrator, synthesizer, five-stage review process, bootstrap, document draft loop, and drift report are **not** installed. Using this adapter does **not** mean that `egm-review`, `egm-brainstorm` or a multi-stage EGM review is available. Google maintains a separate experimental V1 OpenCode adapter.

## Default enablement and opt-out

The normal Harness plugin package contains these resources under `docs/` and `src/`; no manual copying into the project and no `python3 adapters/opencode/install.py` is required.

EGM is enabled when `HARNESS_EGM_ENABLED` is unset (the default). Install/update the Harness plugin and restart/reload OpenCode as usual. The optional `/harness-egm-review` command becomes available without extra configuration. This does **not** automatically run reviews.

To explicitly disable EGM for the OpenCode server process:

```sh
HARNESS_EGM_ENABLED=0 opencode
```

`1`, `true` and `on` also enable; `0`, `false` and `off` disable. Other values are rejected to avoid silent misconfiguration.

The Harness global agent provisioner then creates (or upgrades **only unchanged managed copies**) these profiles in the selected OpenCode global config directory:

- `harness-egm-zoom-out` — simplicity/YAGNI critique;
- `harness-egm-design` — architectural assumptions, failure modes, alternatives;
- `harness-egm-readiness` — implementation-plan actionability.

Existing customized or unmanaged profiles are preserved. An already-running OpenCode session may need restart/reload to see newly provisioned agents. When explicitly disabled, no EGM profiles or command are installed on a fresh configuration; previously installed profiles are not deleted, but the Harness rejects their tool calls and dispatch while disabled.

## Use

In an ordinary Harness orchestrator session, invoke **one targeted review** of an existing *project-local* design file:

```text
/harness-egm-review simplicity docs/designs/auth.md
/harness-egm-review design docs/designs/auth.md
/harness-egm-review readiness docs/designs/auth.md
```

One invocation selects one *fresh foreground* Goldfish reviewer. The Harness orchestrator (Elephant) receives the compact report and distinguishes verified Blocker/Major/Nit issues from uncertainty. Do not invoke the command repeatedly merely to obtain two clean rounds. Resolve important design uncertainties under existing owner authority, then implement through the standard Harness WU pipeline.

Call the regular `/harness` command for intake or `/harness resume ...` for an already active execution. **Do not use EGM during an activated WU or to replace `harness-reviewer`.** EGM critique is not a candidate-bound acceptance receipt, and cannot authorize an Epic, WU, merge or budget change.

The review command requires an existing regular file inside the project and an enabled, loaded V2 subagent profile for the selected mode. It returns explicit errors when unavailable. The reviewer is instructed to read the document and its shipped rubric. Only explicitly relevant source files are to be passed to it; parent conversation and past reports are not to be copied.

## Controls and limits

- **Enabled by default; manually invoked**. Use `HARNESS_EGM_ENABLED=0` for opt-out. No new mandatory review gates, WUs, rounds or budgets.
- **Tool-boundary read-only**: A V2 `execute.before` hook denies EGM reviewer tools other than `read` and `glob`. Reads must resolve inside the active project or the vendored rubrics directory. `.env`, `.git`, credentials and sensitive home directories are denied, including through symlinks. Glob roots must remain inside the project. Ordinary Harness roles are not affected.
- **Dispatch isolation**: Only the Harness orchestrator may launch a listed EGM reviewer, when EGM is enabled and no active WU execution context is associated with the caller. EGM sessions are excluded from the Harness project-instruction and WU-context injection hooks.
- **Preserved invariants**: The existing WU activation, frozen candidate, verification, independent implementation review, merge and historical Phase-4 recovery records remain untouched.
- **Not a proven sandbox**: OpenCode's own user/global/project `AGENTS.md`, enabled plugins and MCP tooling can supply context; "fresh child" is not equivalent to process or complete memory isolation. This adapter prevents Harness-side additions, but native V2 isolation must be checked against the actual loaded runtime. It does not claim Google V2 support or an end-to-end live-model test.
- **Failure handling**: A failed reviewer launch or inaccessible mandatory source is **NOT_REVIEWED**, not a PASS; never synthesize a simulated Goldfish.
- **Scope**: Only design criticism. No automatic document rewrite, EGM five-stage iteration, automated code correction, policy override or autonomous historical recovery.

## Verification before production use

Run the repository checks:

```sh
npm run check
node --test tests/egm-integration.test.js
```

Then in an isolated OpenCode V2 profile and disposable project: verify profile discovery, one real fresh child session, required target/rubric reads, child tool-call denial for write/shell/Harness actions, symlink and `.env` denial, parent-only random marker not leaked via Harness injection, and the effective merged role permissions. Test the existing candidate/WU acceptance path with EGM enabled and disabled. Retain recorded traces; if native isolation fails, run with `HARNESS_EGM_ENABLED=0` and report the limitation. No model call is needed just to install the files.

This feature intentionally does not resolve orphaned-dispatch liveness defects: those belong to the separate Harness recovery controller.
