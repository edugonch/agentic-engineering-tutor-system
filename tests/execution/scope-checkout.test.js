import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { resolveScopeRuntimeCheckout, verifyScopeCheckoutRoots } from "../../src/execution/scope-checkout.js"

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
async function roots(t) {
  const root = await mkdtemp(join(tmpdir(), "scope-roots-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, "init", "-q")
  git(root, "config", "user.name", "Harness test")
  git(root, "config", "user.email", "harness@example.invalid")
  await writeFile(join(root, "file.txt"), "canonical\n")
  git(root, "add", ".")
  git(root, "commit", "-qm", "baseline")
  const linked = join(root, "linked")
  git(root, "worktree", "add", "-q", "--detach", linked, "HEAD")
  const session = {
    id: "ses_orchestrator", agent: "harness-orchestrator",
    projectID: "project-1", location: { directory: linked },
  }
  const ctx = {
    location: { project: { id: "project-1", canonical: root } },
    session: { get: async () => ({ data: session }) },
  }
  return { root, linked, session, ctx }
}

test("verified linked checkout is distinct from canonical state root and remains the current session checkout", async t => {
  const f = await roots(t)
  const resolved = await resolveScopeRuntimeCheckout(f.ctx, f.root, "ses_orchestrator")
  assert.equal(resolved.checkoutRoot, f.linked)
  assert.equal(resolved.canonicalRoot, f.root)
})

test("a source checkout from an unrelated repository cannot provide scope-clearing proof", async t => {
  const f = await roots(t)
  const unrelated = await mkdtemp(join(tmpdir(), "scope-forged-"))
  t.after(() => rm(unrelated, { recursive: true, force: true }))
  git(unrelated, "init", "-q")
  git(unrelated, "config", "user.name", "Harness test")
  git(unrelated, "config", "user.email", "harness@example.invalid")
  await writeFile(join(unrelated, "file.txt"), "identical bytes\n")
  git(unrelated, "add", ".")
  git(unrelated, "commit", "-qm", "other project")
  await assert.rejects(verifyScopeCheckoutRoots(f.root, unrelated), /SCOPE_RECOVERY_FOREIGN_PROJECT/)
  f.session.location.directory = unrelated
  await assert.rejects(resolveScopeRuntimeCheckout(f.ctx, f.root, "ses_orchestrator"), /SCOPE_RECOVERY_FOREIGN_PROJECT/)
})

for (const scenario of ["missing location", "wrong project", "wrong agent", "wrong session", "child session"]) {
  test(`scope proof rejects ${scenario} rather than silently using plugin canonical root`, async t => {
    const f = await roots(t)
    if (scenario === "missing location") delete f.session.location
    if (scenario === "wrong project") f.session.projectID = "project-foreign"
    if (scenario === "wrong agent") f.session.agent = "harness-builder"
    if (scenario === "wrong session") f.session.id = "ses_fake"
    if (scenario === "child session") f.session.parentID = "ses_parent"
    await assert.rejects(resolveScopeRuntimeCheckout(f.ctx, f.root, "ses_orchestrator"),
      /SCOPE_RECOVERY_SESSION_(LOCATION|IDENTITY)/)
  })
}

test("subdirectory of a verified linked checkout resolves to the actual git toplevel, never a model-chosen path", async t => {
  const f = await roots(t)
  await mkdir(join(f.linked, "nested"), { recursive: true })
  f.session.location.directory = join(f.linked, "nested")
  const result = await resolveScopeRuntimeCheckout(f.ctx, f.root, "ses_orchestrator")
  assert.equal(result.checkoutRoot, f.linked)
})
