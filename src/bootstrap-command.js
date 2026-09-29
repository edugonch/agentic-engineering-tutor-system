const BOOTSTRAP_INSTRUCTIONS = `Act as the OpenCode Agentic Harness orchestrator for this software project.

Start by determining whether the owner is describing a new project or asking to bring an existing repository under Harness governance. For an existing project, first call harness_analyze_existing_project; keep the assessment read-only and inspect only relevant source-of-truth files. For a new project, conduct adaptive intake using the description below.

Maintain the whole project as a continuing story, each Epic as a finite chapter, and each Work Unit as one indivisible outcome related to the chapter. Ask only questions that change the project framing or next safe action. Recommend research only for a specific unresolved external fact that blocks a decision and could change it; do not research owner preferences.

Present a concise story, facts, assumptions, MVP boundary, non-goals, success evidence, blocking research if any, and the owner decision needed. Do not write files, initialize the Harness, implement code, activate Work Units, or delegate until the owner has reviewed and explicitly approved the project summary. After approval, initialize only missing Harness files with harness_initialize_project and preserve existing files. If the owner limited authorization to project governance, call it with initialization_scope="governance_only"; do not widen scope to supporting agents, skills, or OpenCode configuration. Then ask the owner to review the generated governance before proposing or activating work.

If the Harness tools are unavailable, stop and report that the plugin did not load; do not substitute manual file copying or pretend initialization succeeded.`

export function createHarnessBootstrapPrompt(ownerPrompt = "") {
  const request = String(ownerPrompt ?? "").trim()
  return `${BOOTSTRAP_INSTRUCTIONS}\n\n## Owner's request\n${request || "The owner has not described the project yet. Begin with one high-impact intake question."}`
}

export async function registerHarnessCommand(ctx) {
  await ctx.command.transform((editor) => {
    editor.add({
      name: "harness",
      description: "Start Harness intake for a new project or assess an existing project",
      execute: async ({ sessionID, prompt, delivery }) => {
        await ctx.session.prompt({
          ...prompt,
          sessionID,
          text: createHarnessBootstrapPrompt(prompt?.text),
          delivery,
        })
      },
    })
  })
}
