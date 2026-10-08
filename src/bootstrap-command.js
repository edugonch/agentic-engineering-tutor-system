import { createOrchestratorOwnership } from "./orchestrator-ownership.js"

const BOOTSTRAP_INSTRUCTIONS = `Act as the OpenCode Agentic Harness orchestrator for this software project.

Start by determining whether the owner is describing a new project or asking to bring an existing repository under Harness governance. For an existing project, first call harness_analyze_existing_project; keep the assessment read-only and inspect only relevant source-of-truth files. For a new project, conduct adaptive intake using the description below.

Maintain the whole project as a continuing story, each Epic as a finite chapter, and each Work Unit as one indivisible outcome related to the chapter. Ask only questions that change the project framing or next safe action. Recommend research only for a specific unresolved external fact that blocks a decision and could change it; do not research owner preferences.

Present a concise story, facts, assumptions, MVP boundary, non-goals, success evidence, blocking research if any, and the owner decision needed. Do not write project files, initialize the Harness, implement code, activate Work Units, or delegate until the owner has reviewed and explicitly approved the project summary. After approval, initialize only missing project files with harness_initialize_project and preserve existing files. If the owner limited authorization to project governance, call it with initialization_scope="governance_only"; this limits files created in the repository. The plugin manages its primary orchestrator and four specialist agent profiles in OpenCode's global agents directory when the plugin loads after installation/update, without copying them into the project. It preserves existing or customized global profiles. Then ask the owner to review the generated project governance before proposing or activating work.

Before asking the owner to activate a Work Unit, call harness_check_agent_readiness. It checks OpenCode's loaded runtime registry, not merely whether profile files exist. If harness-builder or harness-reviewer is missing, disabled, has the wrong mode, or the registry cannot be read, activation is blocked: do not record an activation decision or delegate. Report the provisioning result and exact blocker. Do not manually copy profiles into the repository or edit OpenCode configuration. Recheck immediately before delegation. A blocked preflight does not revoke an activation already explicitly recorded by the owner; it blocks execution and requires reporting that distinction.

If the Harness tools are unavailable, stop and report that the plugin did not load; do not substitute manual file copying or pretend initialization succeeded.`

export function createHarnessBootstrapPrompt(ownerPrompt = "") {
  const request = String(ownerPrompt ?? "").trim()
  return `${BOOTSTRAP_INSTRUCTIONS}\n\n## Owner's request\n${request || "The owner has not described the project yet. Begin with one high-impact intake question."}`
}

export function createHarnessResumePrompt(request = "") {
  return `Continue the existing Harness execution as its primary orchestrator. Read durable status/verify and approved mandate before acting. Preserve execution identity, candidates, reviews, PRs, budgets, and history. Do not restart intake or request approvals already granted. Delegate only the next authorized work; close the Epic only on terminal evidence. If multiple executions match, resolve the intended execution before mutating.\n\nOwner request:\n${String(request).trim()}`
}

export async function registerHarnessCommand(ctx, ownership = createOrchestratorOwnership(ctx)) {
  await ctx.command.transform((editor) => {
    editor.add({
      name: "harness",
      description: "Start Harness intake for a new project or assess an existing project",
      execute: async ({ sessionID, prompt, delivery }) => {
        await ownership.takeOwnership(sessionID)
        const text = String(prompt?.text ?? "")
        const resume = /^resume(?:\s|$)/i.test(text)
        const forwarded = { ...prompt }
        // Prefixing instructions invalidates offsets into the original text.
        if (Array.isArray(forwarded.files)) forwarded.files = forwarded.files.map(({ mention, ...file }) => file)
        await ctx.session.prompt({
          ...forwarded,
          sessionID,
          text: resume ? createHarnessResumePrompt(text.replace(/^resume\s*/i, "")) : createHarnessBootstrapPrompt(text),
          delivery,
        })
      },
    })
  })
}
