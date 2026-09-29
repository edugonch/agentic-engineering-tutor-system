# OpenCode Agentic Harness

An OpenCode-only starter for guiding software projects from discovery through bounded, story-shaped delivery. The project is provider-neutral: the owner explicitly configures the primary orchestrator model and each worker model for the providers available to that project.

The Harness treats the whole project as a continuing story, Epics as finite chapters, and Work Units (WUs) as indivisible outcomes that fit together in a chapter. A WU may depend on or follow another WU, but it cannot recursively create child WUs.

## Current scope

This is an early implementation, not a production automation system. Version 0.1 provides:

- OpenCode plugin tools to initialize new or imported projects, inventory existing projects, inspect Harness files, validate Epic/WU contracts, and search the preserved reference library selectively.
- OpenCode-native orchestrator, builder, researcher, designer, and reviewer profiles, installed into the target project on explicit initialization. The designer is selected only for user-facing UI work within an activated WU.
- OpenCode-native skills for new-project intake, existing-project import, architecture decisions, story/Epic design, bounded research, and WU authoring.
- A bounded, read-only existing-project inventory that helps the orchestrator find current project markers and likely governance sources before it proposes a migration.
- Per-agent step limits, role permissions that restrict the orchestrator to named subagents and prevent recursive delegation, a per-session-run tool-call circuit breaker, a delegation cap, a pre-request output-token cap, and a retry limit.
- Starter governance documents and templates that never overwrite existing files.
- An ADR template and a bounded architecture-verification workflow that match project evidence, primary-source research, scenario tests/prototypes, and owner decisions to the kind of uncertainty.
- A packaged 17-document raw reference corpus with a lightweight local search tool that returns bounded excerpts rather than placing the whole library in model context.

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

Two additional engineering references now inform the agent and skill behavior: Chip Huyen's *AI Engineering* guides context construction, agent failure evaluation, and cost/observability controls; Michael Keeling's *Design It!* guides risk-led discovery, quality scenarios, architecture decisions, and evaluation. See the concise source maps in [`docs/knowledge-base/`](docs/knowledge-base/). The books are not redistributed. The installed projects receive a short provenance and authority note at `.harness/references/ENGINEERING-KNOWLEDGE.md`.

The separately supplied agent/skill/command/plugin source files are preserved in [`docs/reference-library/`](docs/reference-library/). Use the plugin's `harness_search_knowledge` tool for targeted excerpts; the original files are not copied into each project. The retrieval is lexical and heading-aware, and its results remain non-authoritative RAW references.

## Configure models by agent

Model assignment is part of the orchestrator/worker design. The primary session runs `harness-orchestrator`; set its default model with OpenCode's top-level `model` setting. Set each worker's model under the `agents` object. This lets the owner select a more capable model for orchestration and purpose-fit models for implementation, research, design, and review.

The initialization tool creates `.harness/OPENCODE-CONFIG-FRAGMENT.jsonc` with all Harness role names and model placeholders. Replace every placeholder with an available `provider/model-id` from `opencode models` before merging the fragment into the root `opencode.json` or `opencode.jsonc`. The fragment is a template, not a valid configuration until those values are replaced. OpenCode keeps the selected model separately from the selected agent in an existing session; start a new session or select the intended orchestrator model after changing the config.

Example after replacing the placeholders:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "harness-orchestrator",
  "model": "provider/your-orchestrator-model",
  "agents": {
    "harness-builder": { "model": "provider/your-builder-model" },
    "harness-researcher": { "model": "provider/your-research-model" },
    "harness-designer": { "model": "provider/your-design-model" },
    "harness-reviewer": { "model": "provider/your-review-model" }
  }
}
```

The model IDs above are illustrative placeholders, not guaranteed catalog entries. The Harness does not rank models automatically or silently choose a vendor. The owner should choose an orchestration model with sufficient capability for planning and delegation, then select worker models for their roles, capabilities, and cost. Jev is configured separately as a decision provider; it is not an agent model.

Merge these keys into an existing config; do not replace it. The scaffold creates a copyable fragment rather than editing existing OpenCode configuration. A configured worker model overrides the session model; if omitted, OpenCode can make that worker inherit the parent session model.

## Agent relationship

| Role | Responsibility | Boundary |
|---|---|---|
| Orchestrator | Maintains the story, governs scope, assigns bounded work, decides whether research is blocking | Does not implement WUs or invent authority from RAW research |
| Builder | Implements one activated WU and reports evidence | Does not redefine the Epic or create child/successor WUs |
| Researcher | Answers one exact blocking question from named sources | Read-only; no code or backlog changes; returns evidence and uncertainty |
| Reviewer | Independently reviews a defined diff/contract or challenges a consequential architecture decision | Read-only; findings go back to the orchestrator; no self-approval or merge |

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
