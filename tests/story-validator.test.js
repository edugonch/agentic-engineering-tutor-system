import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateStoryFile } from "../src/story-validator.js"

const epic = `# E01\n## Chapter purpose\nEnable a user to complete the first workflow.\n## Start condition\nThe approved project seed is complete.\n## User-visible outcome\nA user can finish the first workflow.\n## Terminal demo and acceptance\n- Demo scenario: A new user completes the workflow.\n- Acceptance evidence: The end-to-end test passes.\n- End condition: The result is saved and shown to the user.\n## Approved WU budget\n- Maximum WU count: 3\n- Budget approval status: APPROVED\n- Approval reference: DEC-004 / 2026-09-29\n## Work Unit sequence\n| Order | WU | Outcome | Depends on | Status |\n|---:|---|---|---|---|\n| 1 | WU-01 | Create workflow | none | DRAFT |\n| 2 | WU-02 | Show saved result | WU-01 | DRAFT |\n## Out of scope\n- Analytics\n`

test("accepts an Epic contract with finite story sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-"))
  try {
    await mkdir(join(root, ".harness", "epics"), { recursive: true })
    await writeFile(join(root, ".harness", "epics", "E01.md"), epic)
    const result = await validateStoryFile(root, ".harness/epics/E01.md", "epic")
    assert.equal(result.status, "PASS")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("separates draft Epic structure from owner approval to activate its chapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-draft-epic-"))
  try {
    const draft = epic
      .replace("# E01\n", "# E01\n\nStatus: DRAFT / NON-EXECUTABLE\n")
      .replace("Maximum WU count: 3", "Maximum WU count: 4")
      .replace("Budget approval status: APPROVED", "Budget approval status: APPROVED para cantidad; ejecución NOT AUTHORIZED")
      .replace("Approval reference: DEC-004 / 2026-09-29", "Approval reference: owner approved the four-WU ceiling; execution budget pending")
    await writeFile(join(root, "E01.md"), draft)
    const result = await validateStoryFile(root, "E01.md", "epic")
    assert.equal(result.status, "PASS_WITH_WARNINGS")
    assert.deepEqual(result.invalid_fields, [])
    assert.equal(result.activation_ready, false)
    assert.ok(result.activation_blockers.some((item) => item.includes("DRAFT / NON-EXECUTABLE")))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("allows pending execution budget only on a non-executable WU draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-draft-wu-"))
  try {
    const draft = [
      "# WU-01",
      "",
      "Status: DRAFT / NON-EXECUTABLE / NOT AUTHORIZED",
      "",
      "## Story and Epic connection",
      "One coherent outcome in E01.",
      "## Single outcome",
      "One coherent, indivisible outcome.",
      "## Acceptance criteria",
      "The user sees the saved result.",
      "## Boundaries",
      "Only this outcome.",
      "## Dependencies",
      "none",
      "CHILD_WORK_UNITS_ALLOWED: NO",
      "## Approved execution budget",
      "- Active-time limit: PENDING — owner approval required",
      "- Approval reference: execution budget pending",
      "## Stop condition",
      "Stop after acceptance.",
      "",
    ].join("\n")
    await writeFile(join(root, "WU.md"), draft)
    const result = await validateStoryFile(root, "WU.md", "wu")
    assert.equal(result.status, "PASS_WITH_WARNINGS")
    assert.deepEqual(result.invalid_fields, [])
    assert.equal(result.activation_ready, false)
    assert.ok(result.activation_blockers.some((item) => item.includes("active-time limit")))

    await writeFile(join(root, "WU.md"), draft.replace("DRAFT / NON-EXECUTABLE / NOT AUTHORIZED", "APPROVED / EXECUTABLE"))
    const executableWithPendingBudget = await validateStoryFile(root, "WU.md", "wu")
    assert.equal(executableWithPendingBudget.status, "FAIL")
    assert.ok(executableWithPendingBudget.invalid_fields.some((item) => item.includes("finite positive active-time limit")))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("rejects an Epic with a placeholder budget, missing closure evidence, or more WUs than approved", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-"))
  try {
    await writeFile(join(root, "E01.md"), epic
      .replace("Approval reference: DEC-004 / 2026-09-29", "Approval reference: [PENDING]")
      .replace("Acceptance evidence: The end-to-end test passes.", "Acceptance evidence: [PENDING]")
      .replace("Maximum WU count: 3", "Maximum WU count: 1")
      .replace("Budget approval status: APPROVED", "Budget approval status: PENDING")
      .replace("| 2 | WU-02 | Show saved result | WU-01 | DRAFT |", "| 2 | WU-02 | Show saved result | WU-01 | DRAFT |\n| 3 | WU-03 | Extra result | WU-02 | DRAFT |"))
    const result = await validateStoryFile(root, "E01.md", "epic")
    assert.equal(result.status, "FAIL")
    assert.equal(result.invalid_fields.length, 4)
    assert.ok(result.invalid_fields.some((field) => field.includes("exceeding the approved maximum")))

    await writeFile(join(root, "E01.md"), epic.replace("Maximum WU count: 3", "Maximum WU count: [OWNER-APPROVED INTEGER]"))
    const placeholderResult = await validateStoryFile(root, "E01.md", "epic")
    assert.equal(placeholderResult.status, "FAIL")
    assert.ok(placeholderResult.invalid_fields.some((field) => field.includes("positive safe integer")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("does not flag explicit prohibition of recursive WU creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-"))
  try {
    await writeFile(join(root, "WU.md"), `## Story and Epic connection\n## Single outcome\nOne coherent outcome, indivisible outcome.\n## Acceptance criteria\nThe user sees the saved result.\n## Boundaries\ntext\n## Dependencies\nnone\nCHILD_WORK_UNITS_ALLOWED: NO\nDo not create child work units.\n## Approved execution budget\n- Active-time limit: 90 minutes\n- Approval reference: DEC-004 / 2026-09-29\n## Stop condition\nStop after the acceptance criteria pass.\n`)
    const result = await validateStoryFile(root, "WU.md", "wu")
    assert.equal(result.status, "PASS")
    assert.deepEqual(result.warnings, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reports missing WU atomicity and recursively generated work", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-"))
  try {
    await writeFile(join(root, "WU.md"), "## Story and Epic connection\n## Single outcome\nCreate a child work unit later.\n")
    const result = await validateStoryFile(root, "WU.md", "wu")
    assert.equal(result.status, "FAIL")
    assert.ok(result.missing_required_sections.includes("acceptance criteria"))
    assert.ok(result.warnings.some((warning) => warning.includes("recursive")))
    assert.ok(result.invalid_fields.some((field) => field.includes("active-time limit")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects document paths outside the project", async () => {
  await assert.rejects(() => validateStoryFile("/tmp/project", "../secret.md", "epic"), /escapes the project root/)
})

test("rejects Epic WU budgets that exceed JavaScript's safe integer range", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-"))
  try {
    await writeFile(join(root, "E01.md"), epic.replace("Maximum WU count: 3", `Maximum WU count: ${"9".repeat(400)}`))
    const result = await validateStoryFile(root, "E01.md", "epic")
    assert.equal(result.status, "FAIL")
    assert.ok(result.invalid_fields.some((field) => field.includes("positive safe integer")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects unbounded or non-numeric WU active-time limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-"))
  try {
    const wu = `## Story and Epic connection\n## Single outcome\nOne coherent, indivisible outcome.\n## Acceptance criteria\nThe user sees the saved result.\n## Boundaries\nOnly this outcome.\n## Dependencies\nnone\nCHILD_WORK_UNITS_ALLOWED: NO\n## Approved execution budget\n- Active-time limit: 90 minutes\n- Approval reference: DEC-004 / 2026-09-29\n## Stop condition\nStop after acceptance.\n`
    for (const duration of ["forever", "unlimited", "1e999 hours", "0 minutes"]) {
      await writeFile(join(root, "WU.md"), wu.replace("90 minutes", duration))
      const result = await validateStoryFile(root, "WU.md", "wu")
      assert.equal(result.status, "FAIL", `${duration} should be rejected`)
      assert.ok(result.invalid_fields.some((field) => field.includes("finite positive active-time limit")))
    }

    await writeFile(join(root, "WU.md"), wu)
    const validResult = await validateStoryFile(root, "WU.md", "wu")
    assert.equal(validResult.status, "PASS")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects duplicate Epic budget fields even when the first value is valid", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-"))
  try {
    const duplicates = [
      ["Maximum WU count", "9".repeat(400)],
      ["Budget approval status", "REJECTED"],
      ["Approval reference", "DEC-005 / 2026-09-30"],
    ]
    for (const [field, contradictoryValue] of duplicates) {
      await writeFile(join(root, "E01.md"), `${epic}- ${field}: ${contradictoryValue}\n`)
      const result = await validateStoryFile(root, "E01.md", "epic")
      assert.equal(result.status, "FAIL", `duplicate ${field} should be rejected`)
      assert.ok(result.invalid_fields.some((message) => message.includes(`${field} must appear exactly once`)))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects duplicate WU budget fields even when the first value is valid", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-validator-"))
  try {
    const wu = `## Story and Epic connection\n## Single outcome\nOne coherent, indivisible outcome.\n## Acceptance criteria\nThe user sees the saved result.\n## Boundaries\nOnly this outcome.\n## Dependencies\nnone\nCHILD_WORK_UNITS_ALLOWED: NO\n## Approved execution budget\n- Active-time limit: 90 minutes\n- Approval reference: DEC-004 / 2026-09-29\n## Stop condition\nStop after acceptance.\n`
    const duplicates = [
      ["Active-time limit", "unlimited"],
      ["Approval reference", "DEC-005 / 2026-09-30"],
    ]
    for (const [field, contradictoryValue] of duplicates) {
      await writeFile(join(root, "WU.md"), `${wu}- ${field}: ${contradictoryValue}\n`)
      const result = await validateStoryFile(root, "WU.md", "wu")
      assert.equal(result.status, "FAIL", `duplicate ${field} should be rejected`)
      assert.ok(result.invalid_fields.some((message) => message.includes(`${field} must appear exactly once`)))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
