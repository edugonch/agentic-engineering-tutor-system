import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const profilePath = resolve(here, "../templates/.opencode/agents/harness-orchestrator.md")

test("orchestrator advances through the predeclared Epic sequence after intermediate completion", async () => {
  const profile = await readFile(profilePath, "utf8")
  assert.match(profile, /complete finite WU sequence is defined when the Epic is approved\/started/i)
  assert.match(profile, /activate the \*\*next already-declared WU in that approved sequence\*\*/i)
  assert.match(profile, /another WU remains in the \*\*predeclared sequence\*\*/i)
  assert.doesNotMatch(profile, /derive exactly one next necessary bounded WU/i)
})

test("orchestrator stops for rebase instead of creating successor WUs", async () => {
  const profile = await readFile(profilePath, "utf8")
  assert.match(profile, /Never derive, create, insert, append, or replace successor WUs while the Epic is executing/i)
  assert.match(profile, /EPIC_REBASE_REQUIRED/i)
  assert.match(profile, /Do not create repair, coordination, research-follow-up, child, or successor WUs automatically/i)
})

test("orchestrator closes Epic only after the final predeclared WU", async () => {
  const profile = await readFile(profilePath, "utf8")
  assert.match(profile, /final predeclared WU/i)
  assert.match(profile, /Call controller action `complete` only after the final predeclared WU is durably complete/i)
  assert.match(profile, /completed=true/i)
  assert.match(profile, /only then close the external Epic tracker item/i)
})

test("predeclared-sequence autonomy does not weaken production or scope gates", async () => {
  const profile = await readFile(profilePath, "utf8")
  assert.match(profile, /does not authorize automatic deploys/i)
  assert.match(profile, /production migrations/i)
  assert.match(profile, /scope expansion/i)
  assert.match(profile, /dynamic WU creation/i)
})
