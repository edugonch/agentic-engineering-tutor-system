# How the supplied agent/skill sources were adapted

The 17 supplied documents are a Claude Code plugin-development library. Their original user-supplied files are now preserved without edits in [`reference-library/raw/`](reference-library/raw/), with a catalog and selective search exposed through `harness_search_knowledge`. They remain reference inputs, not an implementation specification. Their reusable principles guided this OpenCode-only scaffold:

- Skills carry specialized, reusable workflow knowledge; keep the entry instruction focused and place enduring project facts in governance.
- Agent roles need narrow responsibilities, explicit boundaries, concrete steps, stop behavior, and a predictable handoff format.
- Trigger/description quality affects discoverability; explain what the role does and when to use it, without forcing every role into Claude's XML example syntax.
- Treat command/workflow state explicitly, validate inputs and outputs, handle missing context and errors, and provide recovery instructions.
- Test file structure, metadata, references, tool behavior, edge cases, integration, and user-facing installation before distribution.
- Progressive disclosure protects the context window: load project intake/story/research/WU instructions only when relevant; do not place the entire governance library in every agent prompt.

Claude-specific paths, `CLAUDE_PLUGIN_ROOT`, Claude `Task` conventions, `allowed-tools`, Claude model aliases/colors, Claude command syntax such as `$ARGUMENTS`/`!` shell interpolation, and assumptions about Claude's automatic plugin discovery are intentionally not used. OpenCode's current native surfaces are `.opencode/plugins`, `.opencode/agents`, `.opencode/skills`, `AGENTS.md`, its plugin hooks, and provider/model configuration.

The source validator's approach was retained but rewritten as Node tests against OpenCode-compatible templates. Its hard-coded requirement for Claude model names, agent colors, XML `<example>` blocks, and a specific second-person phrase was not ported; validation instead checks actual Harness contract requirements and conservative scope boundaries. The search tool returns only a small number of excerpts and labels source paths/sections; it does not load the whole corpus into model context. Claude-specific claims must be verified against current OpenCode documentation.

The workflow also abstracts the two source projects rather than copying either project structure: Alfran's reported story-shaped, chapter-bounded flow; LLM Learning's reported failure mode of recursive WU expansion and an Epic without closure; and both projects' use of stored raw research to inform decisions. See [`lessons-from-source-projects.md`](lessons-from-source-projects.md). These lessons inform a generic read-only import assessment followed by an owner-approved mapping; they do not assume a specific tracker, project domain, or universal work budget.
