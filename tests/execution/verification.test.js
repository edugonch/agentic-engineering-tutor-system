import test from "node:test"
import assert from "node:assert/strict"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { resolveCheck, runDeclaredCheck, sanitizedEnv, validateVerificationContract } from "../../src/execution/verification.js"

const contract = { commands: [{ id: "run", command: "node -e \"console.log('hello')\"" }, { id: "fail", command: "node -e \"process.exit(3)\"" }], capabilities: ["shell.node"], environment: { network: false } }

test("validates the verification contract", () => {
  assert.equal(validateVerificationContract(contract), true)
  assert.throws(() => validateVerificationContract({ commands: [] }), /at least one/)
  assert.throws(() => validateVerificationContract({ commands: [{ id: "u", command: "node" }, { id: "u", command: "node" }] }), /duplicate/)
  assert.throws(() => validateVerificationContract({ commands: [{ id: "u" }] }), /command string/)
})

test("resolves declared checks and rejects undeclared ones", () => {
  assert.equal(resolveCheck(contract, "run").command, "node -e \"console.log('hello')\"")
  assert.equal(resolveCheck(contract, "missing"), null)
})

test("sanitizedEnv redirects HOME/TMPDIR into the workspace", () => {
  const env = sanitizedEnv("/tmp/ws-1")
  assert.equal(env.HOME, "/tmp/ws-1")
  assert.equal(env.TMPDIR, "/tmp/ws-1")
  assert.equal(env.HARNESS_VERIFICATION, "1")
})

test("runs a declared check to PASS with captured evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-verify-run-"))
  try {
    await writeFile(join(root, "app.js"), "console.log('hi')\n")
    const candidate = await freezeCandidate(root, { paths: ["app.js"] })
    const result = await runDeclaredCheck(candidate, contract, "run")
    assert.equal(result.status, "PASS")
    assert.equal(result.candidate_id, candidate.candidate_id)
    assert.equal(result.tree_hash, candidate.tree_hash)
    assert.match(result.stdout, /hello/)
    assert.equal(result.exitCode, 0)
    assert.ok(result.fingerprint.node)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("returns FAIL for a non-zero exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-verify-fail-"))
  try {
    await writeFile(join(root, "app.js"), "x\n")
    const candidate = await freezeCandidate(root, { paths: ["app.js"] })
    const result = await runDeclaredCheck(candidate, contract, "fail")
    assert.equal(result.status, "FAIL")
    assert.equal(result.exitCode, 3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("returns BLOCKED_UNDECLARED_CHECK for an undeclared check", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-verify-undecl-"))
  try {
    await writeFile(join(root, "app.js"), "x\n")
    const candidate = await freezeCandidate(root, { paths: ["app.js"] })
    const result = await runDeclaredCheck(candidate, contract, "not-declared")
    assert.equal(result.status, "BLOCKED_UNDECLARED_CHECK")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a check that writes files only touches the disposable workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-verify-leak-"))
  try {
    await writeFile(join(root, "app.js"), "x\n")
    const candidate = await freezeCandidate(root, { paths: ["app.js"] })
    const writeContract = { commands: [{ id: "write", command: "node -e \"require('fs').writeFileSync('leak.txt','x')\"" }] }
    const result = await runDeclaredCheck(candidate, writeContract, "write")
    assert.equal(result.status, "PASS")
    // the write went to the (disposed) workspace, not the repo checkout
    await assert.rejects(access(join(root, "leak.txt")))
  } finally { await rm(root, { recursive: true, force: true }) }
})
