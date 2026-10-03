# Harness v1 — pilot onboarding: ALFRAN Dev and LLM Learning

Baseline: `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`.
This document prepares first real use. It does **not** modify the pilot
repositories; actual initialization/import is an owner-approved step.

## Target repositories (discovered on this machine)

| Pilot | Path | Current branch | `.harness` present |
|---|---|---|---|
| ALFRAN Dev (`alfran-web-platform`) | `/Users/poseidon/Documents/alfran/alfran-web-platform` | `wu-055/minimum-commerce-scheduling-contract` | no |
| LLM Learning | `/Users/poseidon/Documents/eLearnProject/LLM-Learning` | `e02-wu-04-learner-intelligence-foundation` | no |

Both are existing projects with their own git history, `AGENTS.md` (ALFRAN),
`.opencode/` (LLM Learning), hooks and CI. Harness import must be additive and
must not overwrite or compete with their existing authorities.

## Preconditions (per pilot)

1. The plugin is loaded at the frozen baseline (section 1 of the operator guide)
   and `harness_check_agent_readiness` returns ready for `harness-builder` and
   `harness-reviewer`.
2. The pilot working tree is clean, or changes are committed/stashed. Record the
   exact starting SHA.
3. The owner explicitly approves bringing that project under governance and the
   import mapping.
4. No Phase-4 `repair_policy` is issued. Harness v1 runs the supported happy path
   only; `CHANGES_REQUIRED`/blockers return control to the owner.

## Shared onboarding procedure

1. Start OpenCode in the pilot repo.
2. Run `/harness` and request import of the existing project.
3. `harness_analyze_existing_project` — bounded read-only inventory.
4. Review the complete discovered set of research, syntheses, rules, decisions,
   specs, stories, Epics and WUs in bounded batches; report truncation; verify
   claims against code. Treat the pilot's existing authority documents (e.g.
   `AGENTS.md`, docs) as source references, not as Harness authority until the
   owner approves the mapping.
5. Owner approves the story + mapping.
6. `harness_import_project_knowledge` (preserve sources with hashes/provenance)
   then `harness_initialize_project` with `project_type: existing` and exact
   references to the pilot's existing story/state authorities.
   - Prefer `initialization_scope: governance_only` initially to avoid writing a
     competing full scaffold into an established repo.
7. Configure model routing (do not silently choose vendors). Keep the pilot's
   existing OpenCode config; merge the Harness keys rather than replacing them.
8. Re-check readiness; then define the first finite Epic.

## ALFRAN Dev specifics

- Existing `AGENTS.md` is extensive. Do not overwrite it; reference it as an
  imported source, and let the Harness orchestrator profile live separately in
  OpenCode config.
- Current branch is a WU branch (`wu-055/...`). Confirm the intended baseline
  branch/SHA before import; do not import mid-feature without a clear starting
  SHA.
- The repo has `.github` CI. Harness does not merge, branch or deploy; CI stays
  the pilot's own gate.

## LLM Learning specifics

- Has a project-local `.opencode/` directory and `.gitattributes`,
  `.gitleaks.toml`, husky hooks. Inspect `.opencode/` before initialization so a
  project-local plugin/agent config does not conflict with the global Harness
  profiles.
- Current branch is `e02-wu-04-...`; confirm the intended starting SHA.
- Keep secrets (`.env.local`) out of any knowledge import; the archive must not
  capture secret material.

## First governed Epic (suggested shape, not authority)

- One finite Epic with one or two WUs, small verifiable outcomes, and an explicit
  `execution_mandate` budget. No `repair_policy`.
- Prefer a real, low-risk, verifiable improvement to validate the pipeline in the
  pilot (for example a single test or a small documented behavior fix), keeping
  changes inside owner-approved paths and fulfilling the pilot's own CI.
- Include the pilot's own check command(s) in the frozen verification contract
  where practical (e.g. its test runner and lint), in addition to any focused
  check.

## Stop / escalation

Stop and return control to the owner on any `CHANGES_REQUIRED`, blocker, budget
exhaustion, ambiguous launch, missing check, readiness gap, or scope/contract
change. v1 does not repair, recover, reset or retry a failed WU.
