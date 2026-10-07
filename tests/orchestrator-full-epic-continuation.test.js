import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const profilePath = resolve(here, "../templates/.opencode/agents/harness-orchestrator.md")

test("orchestrator continues a fully delegated finite Epic after intermediate WU completion", async () => {
  const profile = await readFile(profilePath, "utf8")
  assert.match(profile, /full-Epic autonomous completion/i)
  assert.match(profile, /Treat each successful WU as an internal checkpoint/i)
  assert.match(profile, /After every `complete_wu`, re-evaluate the Epic/i)
  assert.match(profile, /derive exactly one next necessary bounded WU/i)
  assert.match(profile, /without asking the owner for permission already granted by the mandate/i)
})

test("orchestrator requires a terminal closure WU before Epic COMPLETE", async () => {
  const profile = await readFile(profilePath, "utf8")
  assert.match(profile, /terminal closure WU/i)
  assert.match(profile, /Call controller action `complete` only after that terminal closure WU is durably complete/i)
  assert.match(profile, /require `completed=true`/i)
  assert.match(profile, /only after that may the external Epic issue\/state be marked CLOSED\/COMPLETED/i)
  assert.match(profile, /A passing intermediate WU is never sufficient reason to call `complete`/i)
})

test("full-Epic continuation does not weaken production or scope gates", async () => {
  const profile = await readFile(profilePath, "utf8")
  assert.match(profile, /does not authorize automatic deploys/i)
  assert.match(profile, /production migrations/i)
  assert.match(profile, /scope expansion/i)
  assert.match(profile, /builders\/reviewers still cannot create successor WUs/i)
})
