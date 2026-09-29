import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import process from "node:process"

const root = new URL("../", import.meta.url).pathname
const errors = []
const checks = [
  "index.js",
  "src/bootstrap-command.js",
  "tests/bootstrap-command.test.js",
  "src/turn-guard.js",
  "src/scaffold.js",
  "src/project-analysis.js",
  "src/story-validator.js",
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
  if (!/^steps:\s*[1-9][0-9]*\s*$/m.test(content)) errors.push(`${relative(root, path)}: missing finite steps limit`)
  if (/^permission:/m.test(content)) errors.push(`${relative(root, path)}: V2 agent permissions must use "permissions" (plural)`)
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
if (manifest.main !== "./index.js") errors.push('package.json: plugin installer entry point must be "./index.js"')
if (manifest.dependencies?.["@opencode/plugin"] !== "latest") errors.push("package.json: V2 plugin dependency must be @opencode/plugin")
if (manifest.dependencies?.["@opencode-ai/plugin"] || manifest.peerDependencies?.["@opencode-ai/plugin"]) errors.push("package.json: V1 @opencode-ai/plugin must not be included")
const readme = await readFile(join(root, "README.md"), "utf8")
for (const marker of ["opencode plugin add 'github:edugonch/agentic-engineering-tutor-system'", "opencode plugin add 'git+https://github.com/edugonch/agentic-engineering-tutor-system.git#jev-shadow-spike'", "run the plugin command `/harness`", "no manual profile installation"]) {
  if (!readme.includes(marker)) errors.push(`README.md: missing installer/bootstrap instruction ${marker}`)
}
const entry = await readFile(join(root, "index.js"), "utf8")
for (const marker of ["Plugin.define", 'ctx.session.hook("context"', 'ctx.tool.hook("execute.before"', 'ctx.session.hook("retry"', 'name: "harness_search_knowledge"', "registerHarnessCommand(ctx)"]) {
  if (!entry.includes(marker)) errors.push(`index.js: missing V2 runtime contract ${marker}`)
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
