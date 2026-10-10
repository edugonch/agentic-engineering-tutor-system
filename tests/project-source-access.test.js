import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readProjectInstructions, projectInstructionContext } from "../src/project-instructions.js"
import { oneReadArgs, ghReadArgs, assertReadPreview, readExternalSource, runSourceProcess } from "../src/external-source-reader.js"
import { specialistMayUse } from "../src/orchestrator-ownership.js"
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "source-test-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, "skills"))
  await writeFile(join(dir, "AGENTS.md"), "Use WithOne / One CLI. Required source doc-123. Repository edugonch/alfran-web-platform.")
  await writeFile(join(dir, "skills/ROUTER.md"), "Read authority skill only for external sources.")
  return dir
}
test("project instructions are injected verbatim with change-sensitive fingerprint", async t => {
  const root = await fixture(t)
  const first = await readProjectInstructions(root)
  assert.equal(first.documents.length, 2)
  assert.match(projectInstructionContext(first), /WithOne/)
  await writeFile(join(root, "AGENTS.md"), "Changed project policy")
  assert.notEqual((await readProjectInstructions(root)).fingerprint, first.fingerprint)
})
test("instruction reader refuses traversal and external symlinks", async t => {
  const root = await fixture(t)
  await assert.rejects(readProjectInstructions(root, ["../outside"]), /escapes/)
  await symlink("/etc/passwd", join(root, "escape"))
  await assert.rejects(readProjectInstructions(root, ["escape"]), /escapes/)
})
test("source transport is available to reviewer and researcher without governance mutation", () => {
  for (const role of ["harness-reviewer", "harness-researcher"]) {
    assert.equal(specialistMayUse(role, "harness_read_external_source"), true)
    assert.equal(specialistMayUse(role, "harness_read_project_instructions"), true)
    assert.equal(specialistMayUse(role, "harness_execution_controller", { action: "clear_blocker" }), false)
  }
})
test("One has structured read-only argv, no arbitrary commands or flags", () => {
  for (const operation of ["init", "delete", "flow", "exec", "config"]) assert.throws(() => oneReadArgs({ operation }), /Supported/)
  assert.throws(() => oneReadArgs({ operation: "knowledge", action_id: "--output" }), /Invalid/)
  const input = { operation: "read", platform: "google-drive", action_id: "action", connection_key: "connection", source_id: "doc-123", path_variables: { fileId: "doc-123" } }
  const args = oneReadArgs(input)
  assert.ok(args.includes("--path-vars"))
  assert.equal(args.includes("--output"), false)
  assert.throws(() => oneReadArgs({ ...input, path_variables: { fileId: "other" } }), /Exact/)
  assert.throws(() => assertReadPreview({ dryRun: true, request: { method: "POST", url: "https://example.com/doc-123" } }, "doc-123"), /GET/)
  assert.throws(() => assertReadPreview({ dryRun: true, request: { method: "GET", url: "https://example.com/other?q=doc-123" } }, "doc-123"), /exact/)
  assertReadPreview({ dryRun: true, request: { method: "GET", url: "https://example.com/files/doc-123" } }, "doc-123")
})
test("GitHub endpoint rejects arbitrary hosts, traversal and shell operations", () => {
  for (const endpoint of ["https://evil.test", "graphql", "repos/o/r/contents/../secrets", "repos/o/r/contents/%2e%2e", "repos/o/r/hooks"]) assert.throws(() => ghReadArgs({ endpoint }))
  assert.deepEqual(ghReadArgs({ endpoint: "repos/o/r/pulls/168" }), ["api", "--method", "GET", "repos/o/r/pulls/168"])
})
test("One preserves scoped restrictions and isolates credentials; no write preview executes", async t => {
  const root = await fixture(t)
  const previousHome = process.env.HOME
  process.env.HOME = root
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome })
  await mkdir(join(root, ".one"))
  const config = { apiKey: "secret-fixture", accessControl: { connectionKeys: ["only-connection"], actionIds: ["only-action"], knowledgeAgent: false } }
  await writeFile(join(root, ".one/config.json"), JSON.stringify(config))
  const calls = []; let privateHome
  const run = async (_program, args, options) => {
    calls.push(args)
    if (args.includes("config")) return { path: join(root, ".one/config.json") }
    privateHome = options.env.HOME
    const privateConfig = JSON.parse(await readFile(join(privateHome, ".one/config.json"), "utf8"))
    assert.equal(privateConfig.accessControl.permissions, "read")
    assert.deepEqual(privateConfig.accessControl.connectionKeys, ["only-connection"])
    assert.deepEqual(privateConfig.accessControl.actionIds, ["only-action"])
    assert.notEqual(options.cwd, root)
    assert.equal(options.env.NODE_OPTIONS, undefined)
    if (args.includes("--dry-run")) return { dryRun: true, request: { method: "POST", url: "https://www.googleapis.com/drive/v3/files/doc-123", headers: { Authorization: "secret-fixture" } } }
    return { schema: "fixture" }
  }
  await assert.rejects(readExternalSource(root, { provider: "one", operation: "read", source_id: "doc-123", platform: "google-drive", action_id: "only-action", connection_key: "only-connection", path_variables: { fileId: "doc-123" } }, { run, resolveProgram: () => "/trusted/npx" }), /GET/)
  assert.equal(calls.filter(args => args.includes("execute") && !args.includes("--dry-run")).length, 0)
  await assert.rejects(readFile(join(privateHome, ".one/config.json")), /ENOENT/)
  assert.deepEqual(JSON.parse(await readFile(join(root, ".one/config.json"))), config)
})
test("source absent from authority fails before invoking a process", async t => {
  const root = await fixture(t)
  await assert.rejects(readExternalSource(root, { provider: "one", operation: "read", source_id: "other" }, { run: () => assert.fail("must not execute") }), /Exact source_id/)
})

test("successful live observation includes hash and retains pagination, without secrets", async t => {
  const root = await fixture(t)
  const previousHome = process.env.HOME
  process.env.HOME = root
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome })
  await mkdir(join(root, ".one"))
  await writeFile(join(root, ".one/config.json"), JSON.stringify({ apiKey: "fixture-secret" }))
  let executions = 0
  const result = await readExternalSource(root, { provider: "one", operation: "read", source_id: "doc-123", platform: "google-drive", action_id: "read", connection_key: "key", path_variables: { fileId: "doc-123" } }, {
    resolveProgram: () => "/trusted/npx", run: async (_program, args) => {
      if (args.includes("--dry-run")) return { dryRun: true, request: { method: "GET", url: "https://www.googleapis.com/drive/v3/files/doc-123", headers: { Authorization: "fixture-secret" } } }
      if (args.includes("execute")) { executions++; return { response: { version: "98", nextPageToken: "page2", text: "fixture-secret" } } }
      return { docs: "schema" }
    },
  })
  assert.equal(executions, 1)
  assert.equal(result.data.response.nextPageToken, "page2")
  assert.equal(result.data.response.version, "98")
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false)
  assert.equal(typeof result.content_hash, "string")
  assert.match(result.completeness, /never automatic PASS/)
})

test("transport diagnoses auth/permissions without returning secret-bearing stderr", async () => {
  for (const [message, expected] of [["401 unauthorized secret-fixture", "SOURCE_AUTH_REQUIRED"], ["403 forbidden secret-fixture", "SOURCE_PERMISSION_DENIED"], ["404 not found secret-fixture", "SOURCE_NOT_FOUND"]]) {
    await assert.rejects(runSourceProcess(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(message)});process.exit(1)`], { cwd: tmpdir(), env: {} }), error => error.message.includes(expected) && !error.message.includes("secret-fixture"))
  }
})
