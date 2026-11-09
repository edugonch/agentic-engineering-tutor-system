import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tddGate, assertTddPreimplementation } from "../../src/execution/tdd-preflight.js"
import { assertBehavioralNegativeReceipt } from "../../src/execution/process-recovery.js"
import { projectOperationalView } from "../../src/execution/operational-view.js"
import { initialState } from "../../src/execution/state.js"

function state() {
  const s = initialState()
  s.wu = {
    wu_id: "WU66", completed: false,
    contract: {
      process_obligations: [{ kind: "tdd", required: true }],
      verification_contract: { commands: [{ id: "behavior", program: "node", args: ["check.cjs"] }] },
    },
  }
  return s
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tdd-preflight-"))
  await mkdir(join(root, "commerce", "src"), { recursive: true })
  await mkdir(join(root, "commerce", "test"), { recursive: true })
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(root, "src", "production.ts"), "export const x = 42\n")
  const outsider = await mkdtemp(join(tmpdir(), "tdd-outside-"))
  await mkdir(join(outsider, "test"))
  await symlink(join(outsider, "test"), join(root, "external-test"))
  await symlink(join(root, "src", "production.ts"), join(root, "commerce", "test", "pretend.test.ts"))
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outsider, { recursive: true, force: true }) })
  return root
}

test("RED is a durable, WU-scoped pre-implementation stage, not a new WU", () => {
  const s = state()
  assert.deepEqual(tddGate(s), { status: "RED_FIRST", wu_id: "WU66" })
  assert.deepEqual(projectOperationalView(s).tdd_gate, { status: "RED_FIRST", wu_id: "WU66" })
  s.process_red = { WU66: { at_revision: 2, receipt: { evidence_id: "verify-red" } } }
  assert.deepEqual(tddGate(s), { status: "RED_RECORDED", wu_id: "WU66" })
  delete s.process_red
  s.process_recoveries = { WU66: { status: "REPAIRING" } }
  assert.deepEqual(tddGate(s), { status: "RETROSPECTIVE_RECOVERY", wu_id: "WU66" })
  delete s.process_recoveries
  s.wu.contract.process_obligations = []
  assert.deepEqual(tddGate(s), { status: "NOT_REQUIRED" })
  s.wu.contract.process_obligations = [{ kind: "tdd", required: true }]
  s.wu.completed = true
  assert.deepEqual(tddGate(s), { status: "NOT_REQUIRED" })
})

test("pre-RED builder may only use reads and test-file edits, never implementation or shell", async t => {
  const root = await fixture(t)
  const contract = state().wu.contract
  const context = { tdd_gate: { status: "RED_FIRST", wu_id: "WU66" }, contract }
  const event = (tool, path, agent = "harness-builder") => ({
    agent, tool, input: { filePath: path },
  })
  for (const tool of ["read", "glob", "grep", "harness_read_project_instructions", "harness_read_external_source"]) {
    await assertTddPreimplementation(event(tool), context, root)
  }
  for (const file of ["commerce/test/import.test.ts", "src/product.spec.ts", "check.cjs"]) {
    await assertTddPreimplementation(event("edit", file), context, root)
    await assertTddPreimplementation(event("write", file), context, root)
  }
  for (const tool of ["shell", "apply_patch", "subagent", "harness_execution_controller", "mcp_write", "unknown"]) {
    await assert.rejects(assertTddPreimplementation(event(tool, "commerce/test/import.test.ts"), context, root), /TDD_RED_FIRST/)
  }
  for (const bad of ["commerce/src/product.ts", "src/production.ts", "../outside.test.ts", "/tmp/outside.test.ts", ".git/tests/x.test.ts", ".harness/test/seed.test.ts", ".env.test.ts",
    "external-test/escape.test.ts", "commerce/test/pretend.test.ts", "src/file.ts"]) {
    await assert.rejects(assertTddPreimplementation(event("edit", bad), context, root), /TDD_RED_FIRST/, bad)
  }
  await assert.rejects(assertTddPreimplementation(event("edit", undefined), context, root), /TDD_RED_FIRST/)
  // A non-builder is unchanged, as are builder assignments after valid RED or during approved recovery.
  await assertTddPreimplementation(event("shell", "src/production.ts", "harness-reviewer"), context, root)
  await assertTddPreimplementation(event("edit", "src/production.ts"), { ...context, tdd_gate: { status: "RED_RECORDED" } }, root)
  await assertTddPreimplementation(event("edit", "src/production.ts"), { ...context, tdd_gate: { status: "RETROSPECTIVE_RECOVERY" } }, root)
  await assertTddPreimplementation(event("edit", "src/production.ts"), { ...context, tdd_gate: { status: "NOT_REQUIRED" } }, root)
})

test("missing-module failures cannot be recorded as process RED or retrospective negative evidence", () => {
  for (const stderr of [
    "Error: Cannot find module './product'",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'product'",
    "ModuleNotFoundError: No module named 'commerce'",
    "code: 'MODULE_NOT_FOUND'",
    "TypeError [ERR_UNKNOWN_FILE_EXTENSION]: unknown extension",
  ]) {
    assert.throws(() => assertBehavioralNegativeReceipt({ output: { stderr } }), /PROCESS_NON_BEHAVIORAL_RED/)
  }
  for (const stderr of [
    "AssertionError: Expected 73, got 88",
    "AssertionError [ERR_ASSERTION]: false !== true",
    "Tests: 1 failed, expected behavior did not match",
  ]) {
    assert.doesNotThrow(() => assertBehavioralNegativeReceipt({ output: { stderr } }))
  }
})
