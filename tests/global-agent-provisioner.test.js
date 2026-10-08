import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { provisionGlobalHarnessAgents, resolveOpenCodeConfigDir } from "../src/global-agent-provisioner.js"

const ids = ["harness-orchestrator", "harness-builder", "harness-researcher", "harness-reviewer", "harness-designer"]

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harness-global-agents-"))
  const packageRoot = join(root, "package")
  const configDir = join(root, "opencode-config")
  for (const id of ids) {
    const source = join(packageRoot, "templates", ".opencode", "agents", `${id}.md`)
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, `---\ndescription: ${id}\nmode: ${id === "harness-orchestrator" ? "primary" : "subagent"}\n---\n\n${id} system prompt\n`)
  }
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, packageRoot, configDir }
}

test("resolves OpenCode global config directory with explicit and XDG overrides", () => {
  assert.equal(resolveOpenCodeConfigDir({ OPENCODE_CONFIG_DIR: "/custom/opencode" }, "/home/test"), "/custom/opencode")
  assert.equal(resolveOpenCodeConfigDir({ XDG_CONFIG_HOME: "/custom/config" }, "/home/test"), "/custom/config/opencode")
  assert.equal(resolveOpenCodeConfigDir({}, "/home/test"), "/home/test/.config/opencode")
  assert.throws(() => resolveOpenCodeConfigDir({ OPENCODE_CONFIG_DIR: "relative" }, "/home/test"), /absolute path/)
})

test("creates primary orchestrator and four global specialist profiles and is idempotent", async (t) => {
  const { root, packageRoot, configDir } = await fixture(t)
  const first = await provisionGlobalHarnessAgents({ packageRoot, configDir })
  assert.deepEqual(first.created.sort(), ids.slice().sort())
  assert.equal(first.changed, true)
  for (const id of ids) {
    const expected = await readFile(join(packageRoot, "templates", ".opencode", "agents", `${id}.md`), "utf8")
    assert.equal(await readFile(join(configDir, "agents", `${id}.md`), "utf8"), expected)
  }
  assert.equal((await readFile(join(root, "opencode-config", "agents", ".agentic-harness-managed-agents.json"), "utf8")).includes("harness-builder"), true)

  const second = await provisionGlobalHarnessAgents({ packageRoot, configDir })
  assert.equal(second.changed, false)
  assert.deepEqual(second.unchanged.sort(), ids.slice().sort())
})

test("updates an unchanged managed profile when the installed plugin template changes", async (t) => {
  const { packageRoot, configDir } = await fixture(t)
  await provisionGlobalHarnessAgents({ packageRoot, configDir })
  const source = join(packageRoot, "templates", ".opencode", "agents", "harness-builder.md")
  await writeFile(source, "---\ndescription: updated builder\nmode: subagent\n---\n\nUpdated prompt\n")

  const result = await provisionGlobalHarnessAgents({ packageRoot, configDir })
  assert.deepEqual(result.updated, ["harness-builder"])
  assert.match(await readFile(join(configDir, "agents", "harness-builder.md"), "utf8"), /Updated prompt/)
})

test("preserves unmanaged and user-edited profiles instead of overwriting them", async (t) => {
  const { packageRoot, configDir } = await fixture(t)
  const agentDir = join(configDir, "agents")
  await mkdir(agentDir, { recursive: true })
  const custom = "---\ndescription: my builder\nmode: subagent\n---\n\ncustom prompt\n"
  await writeFile(join(agentDir, "harness-builder.md"), custom)
  const first = await provisionGlobalHarnessAgents({ packageRoot, configDir })
  assert.equal(await readFile(join(agentDir, "harness-builder.md"), "utf8"), custom)
  assert.ok(first.preserved.some((item) => item.id === "harness-builder"))

  const reviewerPath = join(agentDir, "harness-reviewer.md")
  const localEdit = `${await readFile(reviewerPath, "utf8")}\nOwner customization\n`
  await writeFile(reviewerPath, localEdit)
  await writeFile(join(packageRoot, "templates", ".opencode", "agents", "harness-reviewer.md"), "new upstream reviewer\n")
  const second = await provisionGlobalHarnessAgents({ packageRoot, configDir })
  assert.equal(await readFile(reviewerPath, "utf8"), localEdit)
  assert.ok(second.preserved.some((item) => item.id === "harness-reviewer"))
})

test("refuses symlinked profile files", async (t) => {
  const { root, packageRoot, configDir } = await fixture(t)
  const agentDir = join(configDir, "agents")
  await mkdir(agentDir, { recursive: true })
  const outside = join(root, "outside.md")
  await writeFile(outside, "leave me alone\n")
  await symlink(outside, join(agentDir, "harness-builder.md"))
  await assert.rejects(provisionGlobalHarnessAgents({ packageRoot, configDir }), /non-regular Harness agent file/)
  assert.equal(await readFile(outside, "utf8"), "leave me alone\n")
})
