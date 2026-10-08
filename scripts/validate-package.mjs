import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import process from "node:process"

const root = new URL("../", import.meta.url).pathname
const errors = []
const checks = [
  "index.js",
  "src/bootstrap-command.js",
  "src/orchestrator-ownership.js",
  "src/orchestrator-steps.js",
  "tests/orchestrator-steps.test.js",
  "tests/orchestrator-ownership.test.js",
  "tests/bootstrap-command.test.js",
  "tests/agent-readiness.test.js",
  "tests/global-agent-provisioner.test.js",
  "src/turn-guard.js",
  "src/scaffold.js",
  "src/project-analysis.js",
  "src/project-knowledge.js",
  "src/story-validator.js",
  "src/agent-readiness.js",
  "src/activation-gate.js",
  "src/global-agent-provisioner.js",
  "src/knowledge-search.js",
  "src/decision/contracts.js",
  "src/decision/jev-provider.js",
  "src/decision/audit.js",
  "src/decision/index.js",
  "templates/.opencode/agents/harness-orchestrator.md",
  "templates/.opencode/agents/harness-builder.md",
  "templates/.opencode/agents/harness-researcher.md",
  "templates/.opencode/agents/harness-reviewer.md",
  "templates/.opencode/agents/harness-designer.md",
  "templates/.opencode/skills/project-intake/SKILL.md",
  "templates/.opencode/skills/project-import/SKILL.md",
  "templates/.opencode/skills/architecture-decision/SKILL.md",
  "templates/.opencode/skills/reference-library-search/SKILL.md",
  "templates/.opencode/skills/story-governance/SKILL.md",
  "templates/.opencode/skills/research-gating/SKILL.md",
  "templates/.opencode/skills/work-unit-authoring/SKILL.md",
  "templates/.harness/templates/ADR.md",
  "templates/.harness/knowledge/README.md",
  "templates/.harness/templates/RESEARCH_RECORD.md",
  "templates/.harness/templates/RESEARCH_SYNTHESIS.md",
  "templates/.harness/templates/REQUIREMENT_SPEC.md",
  "templates/.harness/templates/USER_STORY.md",
  "tests/project-knowledge.test.js",
  "templates/.harness/OPENCODE-CONFIG-FRAGMENT.jsonc",
  "tests/architecture-guidance.test.js",
  "templates/.harness/references/ENGINEERING-KNOWLEDGE.md",
  "docs/knowledge-base/ai-engineering.md",
  "docs/knowledge-base/design-it.md",
  "docs/reference-library/README.md",
  "docs/reference-library/manifest.json",
  "docs/reference-library/SHA256SUMS",
  "docs/third-party/README.md",
  "docs/third-party/licenses/OpenDesign-Apache-2.0.txt",
  "src/execution/constants.js",
  "src/execution/serialize.js",
  "src/execution/fsync.js",
  "src/execution/event-log.js",
  "src/execution/state.js",
  "src/execution/lease.js",
  "src/execution/mutex.js",
  "src/execution/candidate.js",
  "src/execution/execution.js",
  "src/execution/probe.js",
  "src/execution/continuation-driver.js",
  "src/execution/controller-tool.js",
  "src/execution/session-recovery.js",
  "tests/execution/session-recovery.test.js",
  "src/execution/verification-workspace.js",
  "src/execution/verification.js",
  "src/execution/verification-contract.js",
  "src/execution/candidate-registry.js",
  "src/execution/readiness.js",
  "src/execution/index.js",
  "docs/execution-control-plane.md",
  "docs/phase-0-continuation-spike.md",
  "docs/phase-1-verification-substrate.md",
]

for (const path of checks) {
  try {
    const info = await stat(join(root, path))
    if (!info.isFile() || info.size === 0) errors.push(`${path}: missing or empty`)
  } catch {
    errors.push(`${path}: missing`)
  }
}

async function filesIn(dir) {
  const result = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...await filesIn(path))
    else result.push(path)
  }
  return result
}

for (const path of await filesIn("templates/.opencode/skills")) {
  const content = await readFile(join(root, path), "utf8")
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  const name = match?.[1].match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1]
  const description = match?.[1].match(/^description:\s*(.+)$/m)?.[1]
  const directory = path.split("/").at(-2)
  if (!name || name !== directory) errors.push(`${relative(root, path)}: skill name must match its directory`)
  if (!description || description.length < 20) errors.push(`${relative(root, path)}: missing actionable description`)
  if (!content.slice(match?.[0].length ?? 0).trim()) errors.push(`${relative(root, path)}: missing instructions`)
}

for (const path of await filesIn("templates/.opencode/agents")) {
  const content = await readFile(join(root, path), "utf8")
  if (!content.startsWith("---\n") || !/^mode:\s*(primary|subagent)\s*$/m.test(content)) errors.push(`${relative(root, path)}: missing OpenCode agent frontmatter/mode`)
  if (path.endsWith("/harness-orchestrator.md")) {
    if (/^steps:/m.test(content.split("---")[1] ?? "")) errors.push(`${relative(root, path)}: orchestrator must not ship a default steps limit`)
  } else if (!/^steps:\s*[1-9][0-9]*\s*$/m.test(content)) errors.push(`${relative(root, path)}: missing finite steps limit`)
  if (/^permission:/m.test(content)) errors.push(`${relative(root, path)}: V2 agent permissions must use "permissions" (plural)`)
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
if (manifest.main !== "./index.js") errors.push('package.json: plugin installer entry point must be "./index.js"')
if (manifest.dependencies?.["@opencode/plugin"] !== "latest") errors.push("package.json: V2 plugin dependency must be @opencode/plugin")
if (manifest.dependencies?.["@opencode-ai/plugin"] || manifest.peerDependencies?.["@opencode-ai/plugin"]) errors.push("package.json: V1 @opencode-ai/plugin must not be included")
const readme = await readFile(join(root, "README.md"), "utf8")
for (const marker of ["opencode plugin add 'github:edugonch/agentic-engineering-tutor-system'", "opencode plugin add 'git+https://github.com/edugonch/agentic-engineering-tutor-system.git#jev-shadow-spike'", "run the plugin command `/harness`", "no manual profile-copy step", "global specialist profiles"]) {
  if (!readme.includes(marker)) errors.push(`README.md: missing installer/bootstrap instruction ${marker}`)
}
const entry = await readFile(join(root, "index.js"), "utf8")
for (const marker of ["Plugin.define", 'ctx.session.hook("context"', 'ctx.tool.hook("execute.before"', 'ctx.permission.hook("evaluate"', 'ctx.session.hook("retry"', 'name: "harness_search_knowledge"', 'name: "harness_import_project_knowledge"', 'name: "harness_search_project_knowledge"', 'name: "harness_record_knowledge_artifact"', 'name: "harness_check_agent_readiness"', 'name: "harness_continuation_probe"', 'name: "harness_continuation_spike"', 'name: "harness_execution_controller"', 'name: "harness_freeze_candidate"', 'name: "harness_run_verification"', 'name: "harness_check_execution_readiness"', "createContinuationDriver(", "createCandidateRegistry(", "checkExecutionReadiness(", "runExecutionController(", "recordArtifactWithActivationGate(", "registerHarnessCommand(ctx, ownership)"]) {
  if (!entry.includes(marker)) errors.push(`index.js: missing V2 runtime contract ${marker}`)
}

for (const marker of ["provisionGlobalHarnessAgents(", "ctx.agent.reload()", "profile_provisioning"]) {
  if (!entry.includes(marker)) errors.push(`index.js: missing automatic global agent provisioning ${marker}`)
}

const bootstrap = await readFile(join(root, "src/bootstrap-command.js"), "utf8")
for (const marker of ["harness_check_agent_readiness", "do not record an activation decision", "this limits files created in the repository"]) {
  if (!bootstrap.includes(marker)) errors.push(`bootstrap instructions: missing execution preflight rule ${marker}`)
}

const modelConfig = await readFile(join(root, "templates/.harness/OPENCODE-CONFIG-FRAGMENT.jsonc"), "utf8")
for (const marker of ['"default_agent": "harness-orchestrator"', '"model": "provider/orchestrator-model-id"', '"agents": {', '"harness-builder"', '"harness-researcher"', '"harness-designer"', '"harness-reviewer"']) {
  if (!modelConfig.includes(marker)) errors.push(`model configuration fragment: missing ${marker}`)
}

if (errors.length) {
  console.error(errors.map((error) => `FAIL ${error}`).join("\n"))
  process.exitCode = 1
} else {
  console.log(`Validated ${checks.length} core paths, V2 plugin hooks, OpenCode agent profiles, and skill metadata.`)
}
