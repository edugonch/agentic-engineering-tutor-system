import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile, chmod, symlink, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import plugin from "../../index.js"
import { captureCommitSnapshot, freezeCandidate, freezeCandidateFromCommit } from "../../src/execution/candidate.js"
import { candidateGitTree } from "../../src/execution/git-tree.js"
import { createCandidateRegistry } from "../../src/execution/candidate-registry.js"
import { recordKnowledgeArtifact } from "../../src/project-knowledge.js"
import { seedWuContract } from "./wu-fixture.js"

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

function initRepo(root) {
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "harness@test.local"])
  git(root, ["config", "user.name", "Harness Test"])
}

async function seedAndCommit(root) {
  await mkdir(join(root, "foo"))
  for (const [path, text] of [["foo/a", "nested"], ["foo.bar", "sibling"], ["é.txt", "bytes\0x"], ["run", "#!/bin/sh\n"], ["app.js", "app\n"]]) {
    await writeFile(join(root, path), text)
  }
  await chmod(join(root, "run"), 0o755)
  await symlink("foo/a", join(root, "link"))
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "seed"])
}

test("commit freeze captures the exact commit tree, ignoring the working tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "refreeze-commit-"))
  try {
    initRepo(root)
    await seedAndCommit(root)
    const head = git(root, ["rev-parse", "HEAD"])
    const tree = git(root, ["rev-parse", "HEAD^{tree}"])

    // Diverge the working tree from the commit without committing.
    await writeFile(join(root, "app.js"), "drifted working tree\n")
    await writeFile(join(root, "untracked.js"), "never committed\n")

    const base = await captureCommitSnapshot(root, head)
    assert.equal(base.kind, "commit")
    assert.equal(base.commit, head)
    assert.equal(base.tree, tree)
    assert.equal(base.files.find((f) => f.path === "app.js").content, Buffer.from("app\n").toString("base64"))
    assert.equal(base.files.some((f) => f.path === "untracked.js"), false)
    assert.equal(base.files.find((f) => f.path === "run").mode, "100755")
    assert.equal(base.files.find((f) => f.path === "link").type, "symlink")
    assert.equal(base.files.find((f) => f.path === "link").target, "foo/a")

    const candidate = await freezeCandidateFromCommit(root, { commit: head })
    assert.equal(candidate.base.commit, head)
    assert.equal(candidate.base.tree, tree)
    assert.deepEqual(candidate.overlay, [])
    assert.deepEqual(candidate.deletions, [])
    assert.equal(candidateGitTree(candidate), tree)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("commit freeze round-trips through the registry with an identical Git tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "refreeze-registry-"))
  const regDir = join(root, ".harness", "execution")
  try {
    initRepo(root)
    await seedAndCommit(root)
    const head = git(root, ["rev-parse", "HEAD"])
    const tree = git(root, ["rev-parse", "HEAD^{tree}"])

    const candidate = await freezeCandidateFromCommit(root, { commit: head })
    const registry = createCandidateRegistry({ dir: regDir })
    assert.equal((await registry.store(candidate)).status, "STORED")

    const loaded = await registry.load(candidate.candidate_id)
    assert.equal(loaded.candidate_id, candidate.candidate_id)
    assert.equal(loaded.manifest.base.kind, "commit")
    assert.equal(loaded.manifest.base.commit, head)
    assert.equal(loaded.manifest.base.tree, tree)
    assert.equal(candidateGitTree(loaded), tree)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("re-freezing never alters an already-stored candidate (append-only)", async () => {
  const root = await mkdtemp(join(tmpdir(), "refreeze-appendonly-"))
  const regDir = join(root, ".harness", "execution")
  try {
    initRepo(root)
    await seedAndCommit(root)
    const head = git(root, ["rev-parse", "HEAD"])
    const tree = git(root, ["rev-parse", "HEAD^{tree}"])
    const registry = createCandidateRegistry({ dir: regDir })

    const staleWorkingTree = await freezeCandidate(root, { paths: ["app.js"] })
    await registry.store(staleWorkingTree)
    const before = await registry.load(staleWorkingTree.candidate_id)

    const recovered = await freezeCandidateFromCommit(root, { commit: head })
    await registry.store(recovered)

    assert.notEqual(recovered.candidate_id, staleWorkingTree.candidate_id)
    const after = await registry.load(staleWorkingTree.candidate_id)
    assert.equal(after.candidate_id, before.candidate_id)
    assert.equal(after.tree_hash, before.tree_hash)
    assert.equal(after.manifest_hash, before.manifest_hash)
    assert.equal(candidateGitTree(recovered), tree)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("commit freeze preserves the frozen verification contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "refreeze-contract-"))
  try {
    initRepo(root)
    await seedAndCommit(root)
    const head = git(root, ["rev-parse", "HEAD"])
    const contract = { source_wu_id: "E05-03-E", source_wu_hash: "h".repeat(64), source_wu_revision: 7, commands: [{ id: "unit", program: "node", args: ["--test"] }] }
    const candidate = await freezeCandidateFromCommit(root, { commit: head, verification_contract: contract })
    assert.equal(candidate.verification_contract.source_wu_id, "E05-03-E")
    assert.equal(candidate.verification_contract.source_wu_revision, 7)
    assert.equal(candidate.manifest.verification_contract.source_wu_hash, "h".repeat(64))
    assert.match(candidate.manifest.verification_contract.contract_hash, /^[0-9a-f]{64}$/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("identical trees on different commits yield distinct candidates (source commit is identity)", async () => {
  const root = await mkdtemp(join(tmpdir(), "refreeze-identity-"))
  try {
    initRepo(root)
    await seedAndCommit(root)
    const first = git(root, ["rev-parse", "HEAD"])
    git(root, ["commit", "-q", "--allow-empty", "-m", "empty"])
    const second = git(root, ["rev-parse", "HEAD"])
    assert.notEqual(first, second)
    assert.equal(git(root, ["rev-parse", `${first}^{tree}`]), git(root, ["rev-parse", `${second}^{tree}`]))

    const a = await freezeCandidateFromCommit(root, { commit: first })
    const b = await freezeCandidateFromCommit(root, { commit: second })
    assert.equal(a.tree_hash, b.tree_hash) // identical code tree
    assert.equal(a.overlay_hash, b.overlay_hash)
    assert.notEqual(a.manifest_hash, b.manifest_hash) // different source binding
    assert.notEqual(a.candidate_id, b.candidate_id)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("an unavailable source commit fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "refreeze-missing-"))
  try {
    initRepo(root)
    await seedAndCommit(root)
    await assert.rejects(freezeCandidateFromCommit(root, { commit: "0".repeat(40) }), /SOURCE_COMMIT_UNRESOLVED/)
    await assert.rejects(freezeCandidateFromCommit(root, { commit: "HEAD" }), /must be a Git object id/)
    await assert.rejects(freezeCandidateFromCommit(root, { commit: "" }), /must be a Git object id/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("commit freeze refuses a bare tree or blob object id (the source must resolve as a commit)", async () => {
  const root = await mkdtemp(join(tmpdir(), "refreeze-noncommit-"))
  try {
    initRepo(root)
    await seedAndCommit(root)
    const head = git(root, ["rev-parse", "HEAD"])
    const tree = git(root, ["rev-parse", "HEAD^{tree}"])
    const blob = git(root, ["rev-parse", "HEAD:app.js"])
    // A tree peels to itself under `^{tree}`, which is exactly why a tree id must
    // be rejected before tree resolution: it is a valid Git object id but not a
    // source commit.
    assert.equal(git(root, ["rev-parse", `${tree}^{tree}`]), tree)
    assert.notEqual(tree, head)
    assert.notEqual(blob, head)

    await assert.rejects(captureCommitSnapshot(root, tree), /SOURCE_COMMIT_UNRESOLVED/)
    await assert.rejects(captureCommitSnapshot(root, blob), /SOURCE_COMMIT_UNRESOLVED/)
    await assert.rejects(freezeCandidateFromCommit(root, { commit: tree }), /SOURCE_COMMIT_UNRESOLVED/)
    await assert.rejects(freezeCandidateFromCommit(root, { commit: blob }), /SOURCE_COMMIT_UNRESOLVED/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("commit freeze resolves an abbreviated object id to the canonical commit identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "refreeze-canonical-"))
  try {
    initRepo(root)
    await seedAndCommit(root)
    const head = git(root, ["rev-parse", "HEAD"])
    const tree = git(root, ["rev-parse", "HEAD^{tree}"])
    const candidate = await freezeCandidateFromCommit(root, { commit: head.slice(0, 12) })
    assert.equal(candidate.base.commit, head)
    assert.equal(candidate.base.tree, tree)
    assert.equal(candidateGitTree(candidate), tree)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("commit-tree capture refuses a path-traversal entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "refreeze-traversal-"))
  try {
    initRepo(root)
    await writeFile(join(root, "f"), "hi\n")
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", "seed"])
    const blob = git(root, ["hash-object", "-w", "f"])
    // A raw (unvalidated) tree containing a `..` component, wrapped in a real
    // commit: Git normally forbids this, so it proves the capture, not Git,
    // is the boundary that rejects traversal.
    const badTree = execFileSync("git", ["hash-object", "-w", "-t", "tree", "--literally", "--stdin"],
      { cwd: root, input: Buffer.concat([Buffer.from("100644 ../escape\0"), Buffer.from(blob, "hex")]), encoding: "utf8" }).trim()
    const bad = git(root, ["commit-tree", badTree, "-m", "traversal"])
    await assert.rejects(freezeCandidateFromCommit(root, { commit: bad }), /must not contain empty, '\.', or '\.\.' segments/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("commit-tree capture refuses an unsupported Git entry (gitlink/submodule)", async () => {
  const root = await mkdtemp(join(tmpdir(), "refreeze-gitlink-"))
  try {
    initRepo(root)
    await writeFile(join(root, "a"), "a\n")
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", "seed"])
    const head = git(root, ["rev-parse", "HEAD"])
    // Mode 160000 / "commit" is a submodule pointer and carries no candidate blob.
    git(root, ["update-index", "--add", "--cacheinfo", `160000,${head},vendor/sub`])
    const tree = git(root, ["write-tree"])
    const bad = git(root, ["commit-tree", tree, "-m", "gitlink"])
    await assert.rejects(freezeCandidateFromCommit(root, { commit: bad }), /unexpected Git tree record/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("commit-tree capture refuses an unsafe path entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "refreeze-unsafe-"))
  try {
    initRepo(root)
    await writeFile(join(root, "back\\slash"), "x\n")
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", "unsafe"])
    const head = git(root, ["rev-parse", "HEAD"])
    await assert.rejects(freezeCandidateFromCommit(root, { commit: head }), /must use forward slashes/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("re-freezing the same commit is idempotent and never creates a contradictory identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "refreeze-idempotent-"))
  const regDir = join(root, ".harness", "execution")
  try {
    initRepo(root)
    await seedAndCommit(root)
    const head = git(root, ["rev-parse", "HEAD"])
    const tree = git(root, ["rev-parse", "HEAD^{tree}"])
    const registry = createCandidateRegistry({ dir: regDir })

    const first = await freezeCandidateFromCommit(root, { commit: head })
    assert.equal((await registry.store(first)).status, "STORED")
    const second = await freezeCandidateFromCommit(root, { commit: head })
    assert.equal(second.candidate_id, first.candidate_id)
    assert.equal(second.manifest_hash, first.manifest_hash)
    assert.equal(second.tree_hash, first.tree_hash)
    assert.equal((await registry.store(second)).status, "REPLAYED")
    assert.equal(candidateGitTree(await registry.load(first.candidate_id)), tree)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// --- Tool-level: the registered harness_refreeze_candidate operation ---------
//
// Loads the real package entry point and drives the registered tool through a
// controlled host, proving the source commit comes from the durable PR binding
// (never the working tree or PR text) and that drift/missing authority fail
// closed.

async function pluginHost(t) {
  const previousConfig = process.env.OPENCODE_CONFIG_DIR
  const root = await mkdtemp(join(tmpdir(), "refreeze-host-"))
  process.env.OPENCODE_CONFIG_DIR = join(root, "config")
  const agents = new Map(["orchestrator", "builder", "reviewer", "researcher", "designer"].map(role =>
    [`harness-${role}`, { id: `harness-${role}`, name: `harness-${role}`, mode: role === "orchestrator" ? "primary" : "subagent" }]))
  const sessions = new Map([["ses_root", { id: "ses_root", agent: "build" }]])
  const hooks = new Map(), definitions = new Map(), storage = new Map()
  const ctx = {
    app: { version: "2.0.25-fixture" }, location: { project: { canonical: root } },
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    agent: { list: async () => [...agents.values()], get: async ({ agentID }) => agents.get(agentID), reload: async () => {},
      transform: async fn => fn({ update: (id, fn) => { if (agents.has(id)) fn(agents.get(id)) } }) },
    session: { get: async ({ sessionID }) => sessions.get(sessionID), switchAgent: async ({ sessionID, agent }) => { sessions.get(sessionID).agent = agent },
      interrupt: async () => {}, hook: async (name, fn) => hooks.set(`session:${name}`, fn), context: async () => [], wait: async () => {}, prompt: async () => ({}) },
    tool: { hook: async (name, fn) => hooks.set(`tool:${name}`, fn), transform: async fn => fn({ add: definition => definitions.set(definition.name, definition), update: (id, update) => { if (definitions.has(id)) update(definitions.get(id)) } }), list: async () => [...definitions.values()] },
    permission: { hook: async () => {} }, command: { transform: async fn => fn({ add: () => {} }) },
    event: { async *subscribe() {} },
  }
  const cleanup = await plugin.setup(ctx)
  t.after(async () => { cleanup(); if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = previousConfig; await rm(root, { recursive: true, force: true }) })
  const invoke = async (name, input) => {
    const event = { tool: name, id: "call", sessionID: "ses_root", agent: sessions.get("ses_root").agent, input }
    await hooks.get("tool:execute.before")(event)
    return JSON.parse((await definitions.get(name).execute(event.input, { sessionID: "ses_root" })).content)
  }
  // First call transfers ownership to the primary orchestrator.
  await assert.rejects(invoke("harness_execution_controller", { execution_id: "E", action: "status" }), /HARNESS_HANDOFF_REQUIRED/)
  return { root, invoke, run: input => invoke("harness_execution_controller", { execution_id: "E", ...input }) }
}

// Commit a source file and activate an approved WU with its executable contract.
async function activateWu(f) {
  initRepo(f.root)
  await writeFile(join(f.root, "app.js"), "committed\n")
  git(f.root, ["add", "-A"])
  git(f.root, ["commit", "-q", "-m", "seed"])
  const head = git(f.root, ["rev-parse", "HEAD"])
  const tree = git(f.root, ["rev-parse", "HEAD^{tree}"])
  await recordKnowledgeArtifact(f.root, { artifact_type: "epic", artifact_id: "epic-001", title: "Epic", status: "APPROVED", owner_confirmed: true,
    source_refs: ["https://example.com/approval"], content: 'execution_mandate: {"max_wus":1,"total_seconds":200}' })
  await seedWuContract(f.root, "WU-01", "epic-001", 200)
  await f.run({ action: "approve_mandate", epic_artifact_id: "epic-001" })
  await f.run({ action: "activate_wu", wu_id: "WU-01", mandate_id: "E-MANDATE-001" })
  return { head, tree }
}

test("harness_refreeze_candidate derives the source commit from the durable PR binding, not the working tree", async (t) => {
  const f = await pluginHost(t)
  const { head, tree } = await activateWu(f)

  // Freeze the drifted working tree (this becomes the stale bound candidate).
  await writeFile(join(f.root, "app.js"), "drifted working tree\n")
  const stale = await f.invoke("harness_freeze_candidate", { wu_id: "WU-01" })
  await f.run({ action: "record_candidate", candidate_id: stale.candidate_id })
  await f.run({ action: "bind_pr", repository: "owner/repo", pr_number: 217, candidate_id: stale.candidate_id,
    head_sha: head, base_branch: "main", base_sha: "base-0" })

  const refrozen = await f.invoke("harness_refreeze_candidate", { wu_id: "WU-01" })
  assert.equal(refrozen.status, "STORED")
  assert.equal(refrozen.source_commit, head)
  assert.equal(refrozen.source_tree, tree)
  assert.equal(refrozen.git_tree, tree)
  assert.equal(refrozen.previous_candidate_id, stale.candidate_id)
  assert.notEqual(refrozen.candidate_id, stale.candidate_id)

  // Repeating the operation is idempotent: no contradictory duplicate identity.
  const again = await f.invoke("harness_refreeze_candidate", { wu_id: "WU-01" })
  assert.equal(again.status, "REPLAYED")
  assert.equal(again.candidate_id, refrozen.candidate_id)
  assert.equal(again.git_tree, tree)

  // An override that differs from the bound head fails closed.
  await assert.rejects(f.invoke("harness_refreeze_candidate", { wu_id: "WU-01", source_commit: "f".repeat(40) }), /SOURCE_COMMIT_DRIFT/)
})

test("harness_refreeze_candidate fails closed without a bound PR or an executable WU contract", async (t) => {
  const f = await pluginHost(t)
  await activateWu(f)
  // Active WU contract present, but no PR binding yet.
  await assert.rejects(f.invoke("harness_refreeze_candidate", { wu_id: "WU-01" }), /bind the PR first/)
  // No active execution for this WU => no executable contract.
  await assert.rejects(f.invoke("harness_refreeze_candidate", { wu_id: "NOPE" }), /Bind the WU executable contract/)
})

// Bind the durable PR to a chosen head_sha after recording a stale candidate.
async function freezeStaleAndBind(f, { head_sha, pr_number }) {
  await writeFile(join(f.root, "app.js"), "drifted working tree\n")
  const stale = await f.invoke("harness_freeze_candidate", { wu_id: "WU-01" })
  await f.run({ action: "record_candidate", candidate_id: stale.candidate_id })
  await f.run({ action: "bind_pr", repository: "owner/repo", pr_number, candidate_id: stale.candidate_id,
    head_sha, base_branch: "main", base_sha: "base-0" })
  return stale
}

test("harness_refreeze_candidate refuses a durable PR binding whose head is a tree object, not a commit", async (t) => {
  const f = await pluginHost(t)
  const { tree } = await activateWu(f)
  await freezeStaleAndBind(f, { head_sha: tree, pr_number: 219 })
  // The durable binding holds a valid Git object id that is a tree, not a source
  // commit; the recovery must fail closed rather than bind a wrong source identity.
  await assert.rejects(f.invoke("harness_refreeze_candidate", { wu_id: "WU-01" }), /SOURCE_COMMIT_UNRESOLVED/)
})

test("harness_refreeze_candidate refuses a durable PR binding whose head is a blob object, not a commit", async (t) => {
  const f = await pluginHost(t)
  const { head } = await activateWu(f)
  const blob = git(f.root, ["rev-parse", `${head}:app.js`])
  await freezeStaleAndBind(f, { head_sha: blob, pr_number: 220 })
  await assert.rejects(f.invoke("harness_refreeze_candidate", { wu_id: "WU-01" }), /SOURCE_COMMIT_UNRESOLVED/)
})
