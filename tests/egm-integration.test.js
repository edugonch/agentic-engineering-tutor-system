import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  EGM_PROFILES, EGM_UPSTREAM_REVISION, egmEnabled, isEgmReviewer,
  assertEgmDispatch, assertEgmReviewerTool, egmReviewPrompt, registerHarnessEgmCommand,
} from "../src/integrations/egm.js"
import { provisionGlobalHarnessAgents } from "../src/global-agent-provisioner.js"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harness-egm-"))
  const configDir = join(root, "config")
  const projectRoot = join(root, "project")
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(projectRoot, "design.md"), "# Auth design\n")
  await writeFile(join(projectRoot, ".env"), "KEY=secret\n")
  await mkdir(join(projectRoot, "notes"))
  await writeFile(join(projectRoot, "notes", "source.md"), "Evidence\n")
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, configDir, projectRoot }
}

test("EGM is enabled by default, explicitly switchable off, and not the WU reviewer", () => {
  assert.equal(egmEnabled({}), true)
  assert.equal(egmEnabled({ HARNESS_EGM_ENABLED: "" }), true)
  assert.equal(egmEnabled({ HARNESS_EGM_ENABLED: "true" }), true)
  assert.equal(egmEnabled({ HARNESS_EGM_ENABLED: "1" }), true)
  assert.equal(egmEnabled({ HARNESS_EGM_ENABLED: "on" }), true)
  assert.equal(egmEnabled({ HARNESS_EGM_ENABLED: "0" }), false)
  assert.equal(egmEnabled({ HARNESS_EGM_ENABLED: "false" }), false)
  assert.equal(egmEnabled({ HARNESS_EGM_ENABLED: "off" }), false)
  assert.throws(() => egmEnabled({ HARNESS_EGM_ENABLED: "typo" }), /HARNESS_EGM_ENABLED must be/)
  assert.equal(isEgmReviewer("harness-reviewer"), false)
  assert.equal(isEgmReviewer("harness-egm-design"), true)
  assert.deepEqual(Object.keys(EGM_PROFILES), [
    "harness-egm-zoom-out", "harness-egm-design", "harness-egm-readiness",
  ])
  const prompt = egmReviewPrompt({ mode: "simplicity", target: "/project/design.md", standard: "/standard.md" })
  assert.match(prompt, /one NEW foreground subagent: harness-egm-zoom-out/)
  assert.match(prompt, /no iterative reviews/)
  assert.match(prompt, /not a candidate-bound WU implementation review/)
  assert.throws(() => egmReviewPrompt({ mode: "full" }), /EGM_MODE_INVALID/)
})

test("dispatch is restricted to explicit, pre-WU root orchestration", () => {
  const event = { tool: "subagent", agent: "harness-orchestrator", input: { agent: "harness-egm-design" } }
  assert.throws(() => assertEgmDispatch(event, { enabled: false }), /EGM_DISABLED/)
  assert.throws(() => assertEgmDispatch(event, { enabled: true, activeExecution: true }), /EGM_DESIGN_ONLY/)
  assert.throws(() => assertEgmDispatch({ ...event, agent: "harness-builder" }, { enabled: true }), /EGM_DISPATCH_DENIED/)
  assert.doesNotThrow(() => assertEgmDispatch(event, { enabled: true }))
  assert.doesNotThrow(() => assertEgmDispatch({ ...event, input: { agent: "harness-reviewer" } }, { enabled: false }))
})

test("read-only reviewer tool guard prevents writes, Harness calls, secrets and symlink escapes", async t => {
  const { root, projectRoot } = await fixture(t)
  const options = { projectRoot, packageRoot, enabled: true }
  const event = (tool, input) => ({ agent: "harness-egm-design", tool, input })
  await assertEgmReviewerTool(event("read", { filePath: "design.md" }), options)
  await assertEgmReviewerTool(event("read", { filePath: join(packageRoot, "docs", "egm", "upstream", "standards", "feature-spec-standard.md") }), options)
  await assertEgmReviewerTool(event("glob", { pattern: "**/*.md" }), options)
  await assert.rejects(assertEgmReviewerTool(event("edit", { filePath: "design.md" }), options), /EGM_READ_ONLY/)
  await assert.rejects(assertEgmReviewerTool(event("shell", { command: "ls" }), options), /EGM_READ_ONLY/)
  await assert.rejects(assertEgmReviewerTool(event("harness_execution_controller", {}), options), /EGM_READ_ONLY/)
  await assert.rejects(assertEgmReviewerTool(event("read", { filePath: ".env" }), options), /EGM_READ_SCOPE/)
  await assert.rejects(assertEgmReviewerTool(event("read", {}), options), /EGM_READ_SCOPE/)
  await assert.rejects(assertEgmReviewerTool(event("glob", { pattern: "../**/*.md" }), options), /EGM_READ_SCOPE/)
  await assert.rejects(assertEgmReviewerTool(event("glob", { pattern: "**/*.md", cwd: root }), options), /EGM_READ_SCOPE/)
  await symlink(join(root, "outside.md"), join(projectRoot, "link.md"))
  await writeFile(join(root, "outside.md"), "do not read\n")
  await assert.rejects(assertEgmReviewerTool(event("read", { filePath: "link.md" }), options), /EGM_READ_SCOPE/)
  await assert.rejects(assertEgmReviewerTool(event("read", { filePath: "design.md" }), { ...options, enabled: false }), /EGM_DISABLED/)
  // Non-EGM agents preserve the old code-path behavior.
  await assertEgmReviewerTool({ agent: "harness-builder", tool: "edit", input: {} }, options)
})

test("explicit off preserves five core agents; default on provisions EGM personas idempotently", async t => {
  const { configDir } = await fixture(t)
  const first = await provisionGlobalHarnessAgents({ packageRoot, configDir, enableEgm: false })
  assert.equal(first.created.length, 5)
  assert.ok(first.created.every(id => !isEgmReviewer(id)))
  const optedIn = await provisionGlobalHarnessAgents({ packageRoot, configDir })
  assert.deepEqual(optedIn.created.slice().sort(), Object.keys(EGM_PROFILES).sort())
  const profile = await readFile(join(configDir, "agents", "harness-egm-design.md"), "utf8")
  assert.match(profile, new RegExp(EGM_UPSTREAM_REVISION))
  assert.match(profile, /mode: subagent/)
  assert.match(profile, /action: shell[\s\S]*effect: deny/)
  assert.match(profile, /Design Critic Goldfish/)
  const again = await provisionGlobalHarnessAgents({ packageRoot, configDir, enableEgm: true })
  assert.equal(again.changed, false)
  assert.ok(again.unchanged.includes("harness-egm-design"))
  await writeFile(join(configDir, "agents", "harness-egm-design.md"), "owner custom\n")
  const preserved = await provisionGlobalHarnessAgents({ packageRoot, configDir, enableEgm: true })
  assert.ok(preserved.preserved.some(entry => entry.id === "harness-egm-design"))
  assert.equal(await readFile(join(configDir, "agents", "harness-egm-design.md"), "utf8"), "owner custom\n")
})

test("command rejects missing input, nonproject files and missing runtime role, and delegates only via Harness", async t => {
  const { root, projectRoot } = await fixture(t)
  const commands = new Map(), prompts = []
  let owned = 0
  const ctx = {
    location: { project: { canonical: projectRoot } },
    command: { transform: async fn => fn({ add: item => commands.set(item.name, item) }) },
    agent: { list: async () => [{ name: "harness-egm-design", mode: "subagent" }] },
    session: { prompt: async input => prompts.push(input) },
  }
  const ownership = { takeOwnership: async () => { owned++ } }
  assert.equal(await registerHarnessEgmCommand(ctx, ownership, { env: { HARNESS_EGM_ENABLED: "0" }, packageRoot }), false)
  assert.equal(commands.size, 0)
  assert.equal(await registerHarnessEgmCommand(ctx, ownership, { env: {}, packageRoot }), true)
  const execute = commands.get("harness-egm-review").execute
  await assert.rejects(execute({ sessionID: "one", prompt: { text: "design" } }), /Usage/)
  await assert.rejects(execute({ sessionID: "one", prompt: { text: "design ../missing.md" } }), /ENOENT/)
  await assert.rejects(execute({ sessionID: "one", prompt: { text: "simplicity design.md" } }), /EGM_NOT_READY/)
  await execute({ sessionID: "one", prompt: { text: "design design.md" } })
  assert.equal(owned, 1)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].text, /harness-egm-design/)
  assert.match(prompts[0].text, /design.md/)
  assert.match(prompts[0].text, /feature-spec-standard.md/)
  assert.equal(prompts[0].sessionID, "one")
})
