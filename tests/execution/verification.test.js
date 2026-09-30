import test from "node:test"
import assert from "node:assert/strict"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { freezeCandidate } from "../../src/execution/candidate.js"
import { resolveCheck, runCandidateVerification, runCommand, runDeclaredCheck, sanitizedEnv, validateVerificationContract } from "../../src/execution/verification.js"

const contract = {
  commands: [
    { id: "run", program: "node", args: ["-e", "console.log('hello')"] },
    { id: "fail", program: "node", args: ["-e", "process.exit(3)"] },
  ],
  capabilities: ["shell.node"],
  environment: { network_policy: "UNRESTRICTED" },
}

test("validates the verification contract (program + args)", () => {
  assert.equal(validateVerificationContract(contract), true)
  assert.throws(() => validateVerificationContract({ commands: [] }), /at least one/)
  assert.throws(() => validateVerificationContract({ commands: [{ id: "u", program: "node", args: [] }, { id: "u", program: "node", args: [] }] }), /duplicate/)
  assert.throws(() => validateVerificationContract({ commands: [{ id: "u", args: [] }] }), /program/)
  assert.throws(() => validateVerificationContract({ commands: [{ id: "u", program: "node" }] }), /args/)
  assert.throws(() => validateVerificationContract({ commands: [{ id: "u", program: "node", args: [] }], environment: { network_policy: "MAYBE" } }), /network_policy/)
})

test("resolves declared checks and rejects undeclared ones", () => {
  assert.equal(resolveCheck(contract, "run").program, "node")
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
    assert.match(result.stdout, /hello/)
    assert.equal(result.exitCode, 0)
    assert.equal(result.network_policy, "UNRESTRICTED")
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

test("returns BLOCKED_CAPABILITY when the contract requires NETWORK_FORBIDDEN", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-verify-net-"))
  try {
    await writeFile(join(root, "app.js"), "x\n")
    const candidate = await freezeCandidate(root, { paths: ["app.js"] })
    const netForbidden = { commands: [{ id: "run", program: "node", args: ["-e", "1"] }], environment: { network_policy: "NETWORK_FORBIDDEN" } }
    const result = await runDeclaredCheck(candidate, netForbidden, "run")
    assert.equal(result.status, "BLOCKED_CAPABILITY")
    assert.match(result.reason, /NETWORK_FORBIDDEN/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a check that writes files only touches the disposable workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-verify-leak-"))
  try {
    await writeFile(join(root, "app.js"), "x\n")
    const candidate = await freezeCandidate(root, { paths: ["app.js"] })
    const writeContract = { commands: [{ id: "write", program: "node", args: ["-e", "require('fs').writeFileSync('leak.txt','x')"] }] }
    const result = await runDeclaredCheck(candidate, writeContract, "write")
    assert.equal(result.status, "PASS")
    await assert.rejects(access(join(root, "leak.txt")))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("runCommand caps output and kills its process group", async () => {
  const result = await runCommand("node", ["-e", "process.stdout.write('x'.repeat(5000))"], { cwd: tmpdir(), maxOutputBytes: 100 })
  assert.equal(result.ok, true)
  assert.equal(result.truncated, true)
  assert.ok(result.stdout.length <= 100)
})

test("runCandidateVerification runs only the frozen contract's checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-verify-candidate-"))
  try {
    await writeFile(join(root, "app.js"), "console.log('hi')\n")
    const frozen = {
      source_wu_id: "WU-01",
      commands: [{ id: "run", program: "node", args: ["-e", "console.log('from frozen contract')"] }],
      capabilities: ["shell.node"],
    }
    const candidate = await freezeCandidate(root, { paths: ["app.js"], verification_contract: frozen })

    const pass = await runCandidateVerification(candidate, "run")
    assert.equal(pass.status, "PASS")
    assert.match(pass.stdout, /from frozen contract/)

    const undeclared = await runCandidateVerification(candidate, "not-there")
    assert.equal(undeclared.status, "BLOCKED_UNDECLARED_CHECK")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("runCandidateVerification blocks when the candidate has no contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-verify-nocontract-"))
  try {
    await writeFile(join(root, "app.js"), "x\n")
    const candidate = await freezeCandidate(root, { paths: ["app.js"] })
    const result = await runCandidateVerification(candidate, "run")
    assert.equal(result.status, "BLOCKED_NO_CONTRACT")
  } finally { await rm(root, { recursive: true, force: true }) }
})
