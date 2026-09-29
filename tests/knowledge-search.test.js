import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { searchKnowledge } from "../src/knowledge-search.js"

const libraryRoot = fileURLToPath(new URL("../docs/reference-library/", import.meta.url))

test("searches the raw library and returns only a small number of bounded excerpts", async () => {
  const result = await searchKnowledge("agent required frontmatter validation fields", { maxResults: 5 })
  assert.equal(result.status, "OK")
  assert.ok(result.results.length <= 5)
  assert.equal(result.results[0].source_id, "SRC-04")
  for (const item of result.results) {
    assert.ok(item.path.startsWith("docs/reference-library/raw/"))
    assert.ok(item.section)
    assert.ok(item.lines)
    assert.ok(item.excerpt.length <= 1400)
  }
})

test("applies a source filter and returns a safe no-match result", async () => {
  const filtered = await searchKnowledge("agent system prompt persona process", { sourceId: "SRC-05" })
  assert.equal(filtered.status, "OK")
  assert.ok(filtered.results.every((item) => item.source_id === "SRC-05"))

  const missing = await searchKnowledge("quasar-xyzzynotfound")
  assert.equal(missing.status, "NO_MATCH")
  assert.deepEqual(missing.results, [])
})

test("preserves the 17 raw source files byte-for-byte against the recorded checksums", async () => {
  const checksums = await readFile(join(libraryRoot, "SHA256SUMS"), "utf8")
  const entries = checksums.trim().split(/\r?\n/)
  assert.equal(entries.length, 17)
  for (const entry of entries) {
    const [expected, path] = entry.trim().split(/\s+/)
    const content = await readFile(join(libraryRoot, path))
    const actual = createHash("sha256").update(content).digest("hex")
    assert.equal(actual, expected, `${path} changed; update only with intentional source review`)
  }
})
