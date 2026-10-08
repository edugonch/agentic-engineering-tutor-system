import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

test("OpenCode controller schema exposes evidence-backed ambiguous launch recovery", async () => {
  const source = await readFile(new URL("../../index.js", import.meta.url), "utf8")
  assert.match(source, /"resolve_ambiguous_launch"/)
  assert.match(source, /resolution_evidence/)
  assert.match(
    source,
    /bind an externally-established session identity to an AMBIGUOUS dispatch without relaunching/,
  )
})
