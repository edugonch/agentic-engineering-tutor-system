import { Plugin } from "@opencode/plugin"
import { createTurnGuard, readGuardSettings } from "./src/turn-guard.js"
import { getProjectStatus, initializeProject } from "./src/scaffold.js"
import { analyzeExistingProject } from "./src/project-analysis.js"
import { validateStoryFile } from "./src/story-validator.js"
import { searchKnowledge } from "./src/knowledge-search.js"

const json = (value) => ({ content: JSON.stringify(value, null, 2) })
const objectInput = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

export default Plugin.define({
  id: "opencode.agentic-harness",
  async setup(ctx) {
    const settings = readGuardSettings(process.env)
    const guard = createTurnGuard(settings)
    const projectRoot = ctx.location?.project?.canonical
    const requireProjectRoot = () => {
      if (!projectRoot) throw new Error("OpenCode did not provide this plugin location's canonical project root.")
      return projectRoot
    }

    // A fresh user prompt starts a new per-session action budget.
    await ctx.session.hook("prompt", (event) => guard.reset(event.sessionID))

    // V2 calls this hook before every agent-loop request, including tool continuations.
    await ctx.session.hook("context", (event) => {
      if (!event.options.maxTokens || event.options.maxTokens > settings.maxOutputTokens) {
        event.options.maxTokens = settings.maxOutputTokens
      }
    })

    // Allow at most one retry after the initial provider request.
    await ctx.session.hook("retry", (event) => {
      if (event.attempt >= 2) event.decision = { retry: false }
    })

    // Count tool calls and delegations for the session that actually ran them.
    await ctx.tool.hook("execute.before", (event) => {
      guard.before(
        { sessionID: event.sessionID, tool: event.tool },
        { args: event.input },
      )
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "harness_initialize_project",
        description: "Create missing Harness governance, OpenCode agents, and skills in the current canonical project. Call only after the owner has reviewed and explicitly approved the project summary. Never overwrite existing files.",
        input: objectInput({
          project_type: { type: "string", enum: ["new", "existing"] },
          project_name: { type: "string", minLength: 1 },
          problem: { type: "string", minLength: 1 },
          desired_outcome: { type: "string", minLength: 1 },
          mvp: { type: "string", minLength: 1 },
          success_evidence: { type: "string", minLength: 1 },
          import_assessment: { type: "string", maxLength: 20000 },
          owner_confirmed: { type: "boolean" },
        }, ["project_type", "project_name", "problem", "desired_outcome", "mvp", "success_evidence", "owner_confirmed"]),
        execute: async (input) => {
          if (!input.owner_confirmed) {
            return { content: "Initialization stopped: obtain explicit owner approval of the project summary, then call again with owner_confirmed=true. No files were written." }
          }
          if (input.project_type === "existing" && !input.import_assessment?.trim()) {
            return { content: "Initialization stopped: include the owner-approved import mapping and evidence summary in import_assessment. No files were written." }
          }
          return json(await initializeProject(requireProjectRoot(), input))
        },
      })

      editor.add({
        name: "harness_analyze_existing_project",
        description: "Read-only bounded inventory for bringing an existing software project under Harness governance. Reports project markers and likely story, Epic, Work Unit, research, and decision documents; never reads file contents or changes files.",
        input: objectInput({}),
        execute: async () => json(await analyzeExistingProject(requireProjectRoot())),
      })

      editor.add({
        name: "harness_project_status",
        description: "Read the current canonical project's Harness scaffold and report missing files, story state, and a conservative next step. Never edits files.",
        input: objectInput({}),
        execute: async () => json(await getProjectStatus(requireProjectRoot())),
      })

      editor.add({
        name: "harness_validate_story",
        description: "Validate an Epic or Work Unit Markdown contract for required finite boundaries and story relationships. The path must be relative to the canonical project root. Never edits files.",
        input: objectInput({
          document_path: { type: "string", minLength: 1 },
          document_type: { type: "string", enum: ["epic", "wu"] },
        }, ["document_path", "document_type"]),
        execute: async (input) => json(await validateStoryFile(requireProjectRoot(), input.document_path, input.document_type)),
      })

      editor.add({
        name: "harness_search_knowledge",
        description: "Search the plugin's preserved, user-supplied agent/skill/plugin reference library. Returns at most five short, ranked excerpts with source paths and line ranges; does not inject or return the whole corpus. Treat excerpts as non-authoritative evidence and verify platform-specific claims against current official documentation.",
        input: objectInput({
          query: { type: "string", minLength: 3, maxLength: 500, description: "One specific question or concept to find in the preserved reference library." },
          source_id: { type: "string", pattern: "^SRC-(0[1-9]|1[0-7])$", description: "Optional source ID filter, for example SRC-03." },
          max_results: { type: "integer", minimum: 1, maximum: 5, default: 3 },
        }, ["query"]),
        execute: async (input) => json(await searchKnowledge(input.query, input)),
      })
    })
  },
})
