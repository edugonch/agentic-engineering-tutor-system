# OpenCode Agentic Harness

An OpenCode-only starter for guiding software projects from discovery through bounded, story-shaped delivery. The project is provider-neutral: the owner explicitly configures the primary orchestrator model and each worker model for the providers available to that project.

The Harness treats the whole project as a continuing story, Epics as finite chapters, and Work Units (WUs) as indivisible outcomes that fit together in a chapter. A WU may depend on or follow another WU, but it cannot recursively create child WUs.

## Release status (Harness v1)

The supported Harness v1 baseline is the accepted Phase 3 revision
`dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`. See
[`FINAL_RELEASE_REPORT.md`](FINAL_RELEASE_REPORT.md) for the release status,
baseline evidence, capability matrix, installation command and explicit
limitations, and [`docs/phase-5-v1-operator-guide.md`](docs/phase-5-v1-operator-guide.md)
for operator instructions.

The supported v1 autonomy ceiling is:

```text
owner-approved Epic → derived/authorized WU → real builder → frozen candidate
  → deterministic verification → fresh independent reviewer → complete_wu
```

On `CHANGES_REQUIRED` or a blocker, control returns to the owner. Phase-4
autonomous bounded repair/recovery is EXPERIMENTAL / NOT RELEASED and has a known
liveness defect; it is not part of v1. See
[`docs/phase-4-final-status.md`](docs/phase-4-final-status.md).

## Current scope

This is an early implementation, not a production automation system. Version 0.1 provides:

- OpenCode plugin tools to initialize new or imported projects, inventory existing projects and knowledge archives, preserve local/external research snapshots with provenance, search/read project knowledge selectively, record linked research/spec/story artifacts, validate Epic/WU contracts, and search the packaged reference library.
- Automatic global provisioning of the four specialist profiles (`harness-builder`, `harness-researcher`, `harness-reviewer`, `harness-designer`) when the plugin loads after install/update. Managed profiles are refreshed on plugin updates only when unchanged; user-owned or customized profiles are preserved. Provisioning changes OpenCode's global `agents/` directory, not project files.
- A read-only runtime preflight that checks `harness-builder` and `harness-reviewer` are loaded as subagents before activation. The plugin also hard-gates approved activation records and denies actual launches of those Harness roles through OpenCode's permission hook when readiness is missing or unknown.
- OpenCode-native orchestrator, builder, researcher, designer, and reviewer profiles, installed into the target project on explicit initialization. The designer is selected only for user-facing UI work within an activated WU.
- OpenCode-native skills for new-project intake, existing-project import, architecture decisions, story/Epic design, bounded research, and WU authoring.
- A bounded, read-only existing-project inventory that helps the orchestrator find current project markers and likely governance sources before it proposes a migration.
- Per-agent step limits, role permissions that restrict the orchestrator to named subagents and prevent recursive delegation, a per-session-run tool-call circuit breaker, a delegation cap, a pre-request output-token cap, and a retry limit.
- Starter governance documents and templates that never overwrite existing files.
- An ADR template and a bounded architecture-verification workflow that match project evidence, primary-source research, scenario tests/prototypes, and owner decisions to the kind of uncertainty.
- A packaged 17-document raw reference corpus with a lightweight local search tool that returns bounded excerpts rather than placing the whole library in model context.

It does not publish to npm, create GitHub issues, create branches, commit, merge, or deploy. Human ownership and merge policy remain project decisions. No Claude Code files or integrations are included.

The `harness_validate_story` tool checks contract structure separately from permission to execute. A well-formed DRAFT / NON-EXECUTABLE Epic or WU may return PASS_WITH_WARNINGS while `activation_ready` remains false and `activation_blockers` lists missing owner approvals or execution budgets. A non-draft WU with an unbounded or unapproved execution budget still fails validation. Separately, `harness_check_agent_readiness` inspects OpenCode's loaded runtime registry; missing or unknown builder/reviewer roles block activation and delegation. A file on disk alone does not prove that OpenCode loaded the role. The artifact writer also refuses to record an approved WU activation decision while the runtime role preflight is blocked.

## Install with OpenCode's plugin installer

Install the plugin through OpenCode. On the next server load, the plugin provisions its global specialist agents; there is no manual profile-copy step:

```sh
opencode plugin add 'github:edugonch/agentic-engineering-tutor-system'
```

The plugin provisions or updates its global specialist profiles when its setup runs. After an update, restart or reload the OpenCode server if it has not reloaded the package. To test the unmerged Jev spike branch with the same plugin installer:

```sh
opencode plugin add 'git+https://github.com/edugonch/agentic-engineering-tutor-system.git#jev-shadow-spike'
```

Confirm the package appears with `opencode plugin list`. If it does not, inspect the resolved configuration with `opencode debug config` and review OpenCode startup errors. The package declares `main: ./index.js` as its server entry point and targets the OpenCode V2 plugin API (`@opencode/plugin`); it has no Claude Code or V1 implementation.

## Start a new project

1. Start OpenCode in the project and run the plugin command `/harness` with the project idea. The plugin command and global Harness specialists are registered by the plugin; no project-local agent installation is needed for governance-only projects.
2. The orchestrator conducts adaptive intake about the problem, intended outcome, MVP, constraints, users, and success evidence.
3. Review the proposed project story and charter. The plugin must not initialize files until you approve the summary.
4. After approval, the orchestrator calls `harness_initialize_project` with `project_type: new` and `owner_confirmed: true`. The default `initialization_scope: full` creates the complete project-local scaffold, only where files are missing. If the owner authorized project governance but not project-local supporting files, use `initialization_scope: governance_only`; the plugin's global specialists remain available independently.
5. Restart OpenCode or start a new session, select `harness-orchestrator`, and review the generated governance. Before asking to activate a WU, run `harness_check_agent_readiness`. If a required specialist is still absent or the runtime inventory is unknown, keep the WU unactivated and report the provisioning error. Recheck immediately before delegation.
6. Define a finite first Epic with an owner-approved WU count and terminal demo/acceptance condition.

## Bring an existing project under governance

1. Start OpenCode in the existing repository and run `/harness` with a request to import the project.
2. The bootstrap instructions direct the orchestrator to call `harness_analyze_existing_project`, which returns a bounded path inventory and project markers without reading file contents or writing files.
3. The orchestrator reviews the complete discovered set of research, compendia/syntheses, rules, decisions, requirements/specifications, state, Epics, stories, and WUs in bounded batches; it reports inventory truncation and verifies claims against code where needed. Google Drive sources are retrieved by exact ID/revision using the project's configured One CLI/MCP route.
4. Review the mapping, current status, conflicts, open-ended work, and non-goals. A legacy Epic with recursive expansion or no ending must be handled as a rebase decision, not imported as an active infinite chapter.
5. Only after you approve the story and mapping does it call `harness_import_project_knowledge` to preserve relevant local documents and exact-revision external source snapshots with SHA-256 hashes, retrieval dates, classifications, declared authority, and relationships. Snapshots are marked `SNAPSHOT_UNVERIFIED`; they remain references until checked against their live authority. It then calls `harness_initialize_project` with `project_type: existing`, the approved mapping, and exact references to existing story/state authorities. The scaffold writes pointer files rather than creating competing story/state copies.

The project archive lives under `.harness/knowledge/`. Use `harness_search_project_knowledge` and `harness_read_project_knowledge` before collecting prior research again. `harness_record_knowledge_artifact` stores RAW research, compendia, syntheses, requirements/specifications, user stories, Epics, WUs, decisions, or rules as immutable linked records. Raw evidence remains separate from synthesis; an approved user story must parent to an indexed owner-approved requirement/specification. Binary research files are preserved unchanged; inspect/extract them with the project document reader and save any extraction separately with its source record key.

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

Merge these keys into an existing config; do not replace it. The scaffold creates a copyable fragment rather than editing existing OpenCode configuration. This model-routing fragment is separate from plugin installation; the plugin and `/harness` bootstrap do not require copying local plugin files. A configured worker model overrides the session model; if omitted, OpenCode can make that worker inherit the parent session model.

## Agent relationship

| Role | Responsibility | Boundary |
|---|---|---|
| Orchestrator | Maintains the story, governs scope, assigns bounded work, decides whether research is blocking | Does not implement WUs or invent authority from RAW research |
| Builder | Implements one activated WU and reports evidence | Does not redefine the Epic or create child/successor WUs |
| Researcher | Answers one exact blocking question from named sources | Read-only; no code or backlog changes; returns evidence and uncertainty |
| Reviewer | Independently reviews a defined diff/contract or challenges a consequential architecture decision | Read-only; findings go back to the orchestrator; no self-approval or merge |

The orchestrator can delegate only to its named Harness specialists, each of which is denied further subagent use. Research is optional and must resolve a decision that blocks the next authorized step.

## Cost and loop controls

OpenCode provides a `steps` limit per agent. The orchestrator's permissions allow only the named Harness subagents; each specialist is denied subagent use. The plugin adds an optional maximum number of tool calls per session run, a delegation ceiling, a repeated mutation/delegation-call detector, an optional pre-request output-token cap, and a retry ceiling.

These controls reduce runaway work; they do **not** guarantee a maximum token or dollar cost. V2's request hook can cap agent-loop output tokens, but this plugin cannot reliably account for provider-specific input usage and total USD across agents and auxiliary requests. Set provider-side spending limits as a second control. See [`docs/architecture.md`](docs/architecture.md).

Environment overrides:

| Variable | Default | Effect |
|---|---:|---|
| `HARNESS_MAX_TOOL_CALLS` | Disabled (unlimited) | Optional tool executions allowed in one OpenCode session run; when unset or empty, no total tool-call ceiling is enforced |
| `HARNESS_MAX_DELEGATIONS` | `3` | Calls to OpenCode's `subagent` tool allowed in one session run |
| `HARNESS_MAX_IDENTICAL_MUTATIONS` | `4` | Consecutive identical `subagent`, `bash`, `write`, `edit`, `patch`, or `apply_patch` calls before the circuit breaker trips |
| `HARNESS_MAX_OUTPUT_TOKENS` | Disabled | Optional upper bound for each agent-loop response; when set, OpenCode receives this output-token limit |

Each OpenCode session, including each subagent session, has its own counters; a new prompt resets that session's action budget. Total tool calls are unlimited by default; when `HARNESS_MAX_TOOL_CALLS` is explicitly set, that per-session call ceiling and the orchestrator delegation ceiling give a finite action bound, while agent `steps` limits usually stop earlier. This is not a precise dollar ceiling: input-token use and provider-side retries/cost reporting can vary. Configure provider spending limits as a second control.

## Development

```sh
npm test
npm run validate
```

Requires a modern Node.js runtime for the pure-JavaScript test and validation suite. Loading the plugin itself requires OpenCode.

## Jev shadow-mode experiment (opt-in)

The plugin can call OpenCode Zen / TypeSafe Jev in **shadow mode** to collect structured decision signals for evaluation. Jev estimates; the deterministic Harness policy still decides. The signals are never used to select agents, change context, approve work, or execute actions.

To enable the experiment:

```sh
export HARNESS_JEV_ENABLED=1
export HARNESS_JEV_API_KEY="your-opencode-console-api-key"
```

Optional overrides:

| Variable | Default | Effect |
|---|---|---|
| `HARNESS_JEV_MODEL` | `jev-1.13-free` | Jev model ID; configure another model if the free tier changes |
| `HARNESS_JEV_ENDPOINT` | `https://opencode.ai/zen/v1/systemone` | System One evaluation endpoint |
| `HARNESS_JEV_TIMEOUT_MS` | `5000` | Per-request timeout |
| `HARNESS_JEV_MAX_RETRIES` | `1` | At most one retry; values above `1` are capped to `1` |
| `HARNESS_JEV_AUDIT` | unset | Set to `1` to persist redacted audit records |
| `HARNESS_JEV_AUDIT_PATH` | `.harness/audit/jev-decisions.ndjson` | NDJSON audit path relative to the project root |

When Jev is disabled or misconfigured, or when Jev returns an error or times out, the orchestrator behaves exactly as before.

**Data transmission:** enabling Jev sends the first 2,000 characters of each admitted user prompt to OpenCode Zen for evaluation. The local audit does not persist that text.

Audit records contain only a non-sensitive task identifier, schema version, requested/actual model, signals, usage tokens (when provided), latency, and a sanitized status or error. They never include prompts, source code, secrets, or repository contents.

The Jev integration uses the OpenCode V2 `prompt` admission hook, keyed by `messageID` to avoid duplicate calls when admission is retried. Prompt hooks are not an exactly-once boundary, so the implementation limits Jev to at most one in-flight request per admitted message and never awaits the call in the hook.

## Compatibility

This initial implementation targets OpenCode V2. OpenCode documents V1 and V2 as separate plugin APIs; V1 plugin implementations do not run in V2. Verify the installed OpenCode release against the official [V2 plugin](https://opencode.ai/v2/docs/build/plugins), [agent](https://opencode.ai/v2/docs/agents), [skill](https://opencode.ai/v2/docs/skills), and [configuration](https://opencode.ai/v2/docs/config) references before production use.
