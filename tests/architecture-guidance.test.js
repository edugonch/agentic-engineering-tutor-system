import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (path) => readFile(join(root, path), "utf8")

test("architecture guidance maps uncertainty to bounded verification and owner authority", async () => {
  const [skill, orchestrator, reviewer, adr] = await Promise.all([
    read("templates/.opencode/skills/architecture-decision/SKILL.md"),
    read("templates/.opencode/agents/harness-orchestrator.md"),
    read("templates/.opencode/agents/harness-reviewer.md"),
    read("templates/.harness/templates/ADR.md"),
  ])

  for (const marker of ["Current project fact", "External/platform fact", "Empirical behavior", "Product/policy preference", "one exact", "stop condition", "One challenge only", "OWNER_DECISION_REQUIRED"]) {
    assert.ok(skill.includes(marker), `architecture skill must include ${marker}`)
  }
  assert.match(orchestrator, /ask `harness-reviewer` for one independent read-only architecture challenge/i)
  assert.match(reviewer, /DESIGN_SOUND.*DESIGN_CONCERNS.*BLOCKED/s)
  assert.match(reviewer, /cannot choose a product trade-off or approve an ADR/)
  assert.match(adr, /Verification plan and evidence/)
  assert.match(adr, /Approval reference and date/)
})
