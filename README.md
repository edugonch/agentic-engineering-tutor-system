# OpenCode Agentic Harness

An OpenCode-only starter for guiding software projects from discovery through bounded, story-shaped delivery. The project is intentionally provider-neutral: agents inherit the user's configured model unless a project owner explicitly selects a model.

The Harness treats the whole project as a continuing story, Epics as finite chapters, and Work Units (WUs) as indivisible outcomes that fit together in a chapter. A WU may depend on or follow another WU, but it cannot recursively create child WUs.

## Current scope

This is an early implementation, not a production automation system. Version 0.1 provides:

- OpenCode plugin tools to initialize new or imported projects, inventory existing projects, inspect Harness files, and validate Epic/WU contracts.
- OpenCode-native orchestrator, builder, researcher, and reviewer profiles, installed into the target project on explicit initialization.
- OpenCode-native skills for new-project intake, existing-project import, story/Epic design, bounded research, and WU authoring.
- A bounded, read-only existing-project inventory that helps the orchestrator find current project markers and likely governance sources before it proposes a migration.
- Per-agent step limits, role permissions that restrict the orchestrator to named subagents and prevent recursive delegation, a per-session-run tool-call circuit breaker, a delegation cap, a pre-request output-token cap, and a retry limit.
- Starter governance documents and templates that never overwrite existing files.

It does not publish to npm, create GitHub issues, create branches, commit, merge, or deploy. Human ownership and merge policy remain project decisions. No Claude Code files or integrations are included.

## Install from this GitHub repository

The OpenCode CLI supports installing a plugin from a GitHub source. From a terminal, run:

```sh
opencode plugin add 'github:edugonch/agentic-engineering-tutor-system'
```

Then restart OpenCode. The package entry point uses the OpenCode V2 plugin API (`@opencode/plugin`). This repository does not include a Claude Code implementation or a V1 compatibility layer.

## Start a new project

1. Start OpenCode in the project and choose `harness-orchestrator` as the primary agent (or set it as `default_agent` in `opencode.json[c]`).
2. Describe the project in ordinary language. The orchestrator conducts a short, adaptive intake before creating files: problem, intended outcome, MVP, constraints, users, and success evidence.
3. Review the proposed project story and charter. Ask the orchestrator to initialize only after approving that summary.
4. The orchestrator calls `harness_initialize_project` with `project_type: "new"` and `owner_confirmed: true`. The tool creates only missing files and reports any paths it left untouched.
5. Define a finite first Epic with an owner-approved WU count and terminal demo/acceptance condition. Do not treat the full project roadmap as one Epic.

## Bring an existing project under governance

1. Start OpenCode in the existing repository and choose `harness-orchestrator`.
2. Ask it to assess/import the existing project. It calls `harness_analyze_existing_project`, which returns a bounded path inventory and project markers without reading file contents or writing files.
3. The orchestrator inspects only relevant source-of-truth files, reconstructs the project story from evidence, and proposes which existing Epics, WUs, research, and decisions map to Harness governance.
4. Review the mapping, current status, conflicts, open-ended work, and non-goals. A legacy Epic that expands recursively or has no ending must be treated as a rebase decision, not imported as an active infinite chapter.
5. Only after you approve the story and mapping should it call `harness_initialize_project` with `project_type: "existing"` and the approved mapping. That tool records the mapping in `.harness/IMPORT_ASSESSMENT.md`, adds other missing Harness files, and preserves every existing file. Review those generated files before authorizing work.

Import is a separate assessment path from new-project intake. The plugin does not assume Alfran's or LLM Learning's domain or tracker structure; it abstracts story, finite-chapter, indivisible-WU, bounded-research, and owner-authority rules. LLM Learning can later serve as a pilot for this import flow without becoming the product being built here.

The design record summarizes how the source-project lessons map into reusable governance: [`docs/lessons-from-source-projects.md`](docs/lessons-from-source-projects.md). The adaptation of the supplied agent/skill-development references is documented in [`docs/source-adaptation.md`](docs/source-adaptation.md).

Recommended project config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "harness-orchestrator"
}
```

Merge these keys into an existing config; do not replace it. The scaffold creates a copyable fragment rather than editing existing OpenCode configuration.

## Agent relationship

| Role | Responsibility | Boundary |
|---|---|---|
| Orchestrator | Maintains the story, governs scope, assigns bounded work, decides whether research is blocking | Does not implement WUs or invent authority from RAW research |
| Builder | Implements one activated WU and reports evidence | Does not redefine the Epic or create child/successor WUs |
| Researcher | Answers one exact blocking question from named sources | Read-only; no code or backlog changes; returns evidence and uncertainty |
| Reviewer | Independently reviews a defined diff/contract | Read-only; findings go back to the orchestrator; no self-approval or merge |

The orchestrator can delegate only to its named Harness specialists, each of which is denied further subagent use. Research is optional and must resolve a decision that blocks the next authorized step.

## Cost and loop controls

OpenCode provides a `steps` limit per agent. The orchestrator's permissions allow only the named Harness subagents; each specialist is denied subagent use. The plugin adds a maximum number of tool calls per session run, a delegation ceiling, a repeated mutation/delegation-call detector, a pre-request cap on output tokens per agent-loop request, and a retry ceiling.

These controls reduce runaway work; they do **not** guarantee a maximum token or dollar cost. V2's request hook can cap agent-loop output tokens, but this plugin cannot reliably account for provider-specific input usage and total USD across agents and auxiliary requests. Set provider-side spending limits as a second control. See [`docs/architecture.md`](docs/architecture.md).

Environment overrides:

| Variable | Default | Effect |
|---|---:|---|
| `HARNESS_MAX_TOOL_CALLS` | `40` | Tool executions allowed in one OpenCode session run |
| `HARNESS_MAX_DELEGATIONS` | `3` | Calls to OpenCode's `subagent` tool allowed in one session run |
| `HARNESS_MAX_IDENTICAL_MUTATIONS` | `4` | Consecutive identical `subagent`, `bash`, `write`, `edit`, `patch`, or `apply_patch` calls before the circuit breaker trips |
| `HARNESS_MAX_OUTPUT_TOKENS` | `4096` | Upper bound for each agent-loop response; set higher to allow longer responses |

Each OpenCode session, including each subagent session, has its own counters; a new prompt resets that session's action budget. The per-session call ceiling and orchestrator delegation ceiling give a finite action bound, while agent `steps` limits usually stop earlier. This is not a precise dollar ceiling: input-token use and provider-side retries/cost reporting can vary. Configure provider spending limits as a second control.

## Development

```sh
npm test
npm run validate
```

Requires a modern Node.js runtime for the pure-JavaScript test and validation suite. Loading the plugin itself requires OpenCode.

## Compatibility

This initial implementation targets OpenCode V2. OpenCode documents V1 and V2 as separate plugin APIs; V1 plugin implementations do not run in V2. Verify the installed OpenCode release against the official [V2 plugin](https://opencode.ai/v2/docs/build/plugins), [agent](https://opencode.ai/v2/docs/agents), [skill](https://opencode.ai/v2/docs/skills), and [configuration](https://opencode.ai/v2/docs/config) references before production use.
