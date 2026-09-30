import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveBinary } from "../src/resolve-binary.js"

test("resolves only regular files that carry an executable bit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-resolve-bin-"))
  try {
    await writeFile(join(dir, "exec-tool"), "#!/bin/sh\nexit 0\n")
    await chmod(join(dir, "exec-tool"), 0o755)
    await writeFile(join(dir, "plain-tool"), "not executable\n")
    await chmod(join(dir, "plain-tool"), 0o644)

    const resolved = resolveBinary("exec-tool", { PATH: dir })
    assert.ok(resolved, "an executable file on PATH must resolve")
    assert.equal(resolved, join(dir, "exec-tool"))

    assert.equal(
      resolveBinary("plain-tool", { PATH: dir }),
      null,
      "an existing but non-executable file must not resolve",
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
