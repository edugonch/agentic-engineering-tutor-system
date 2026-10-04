import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises"
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

test("1. absolute executable regular file resolves independent of PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-resolve-bin-abs-"))
  try {
    const executable = join(root, "absolute-exec")
    const unrelated = join(root, "unrelated-path-dir")
    await writeFile(executable, "#!/bin/sh\nexit 0\n")
    await chmod(executable, 0o755)
    await mkdir(unrelated)

    assert.equal(
      resolveBinary(executable, { PATH: "" }),
      executable,
      "absolute executable regular file must resolve with an empty PATH",
    )
    assert.equal(
      resolveBinary(executable, { PATH: unrelated }),
      executable,
      "absolute executable regular file must resolve with an unrelated PATH",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("2. nonexistent absolute path returns null", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-resolve-bin-abs-"))
  try {
    assert.equal(
      resolveBinary(join(root, "missing"), { PATH: "" }),
      null,
      "a nonexistent absolute path must not resolve",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("3. absolute directory path returns null even with execute bits", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-resolve-bin-abs-"))
  try {
    const directory = join(root, "directory")
    await mkdir(directory, { mode: 0o755 })

    assert.equal(
      resolveBinary(directory, { PATH: "" }),
      null,
      "an absolute directory path must not resolve, even with execute bits",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("4. absolute non-executable regular file returns null", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-resolve-bin-abs-"))
  try {
    const plain = join(root, "plain")
    await writeFile(plain, "not executable\n")
    await chmod(plain, 0o644)

    assert.equal(
      resolveBinary(plain, { PATH: "" }),
      null,
      "an absolute non-executable regular file must not resolve",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("5. simple-name PATH search still finds executable regular files", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-resolve-bin-abs-"))
  try {
    const executable = join(root, "executable")
    const unrelated = join(root, "unrelated-path-dir")
    await writeFile(executable, "#!/bin/sh\nexit 0\n")
    await chmod(executable, 0o755)
    await mkdir(unrelated)

    assert.equal(
      resolveBinary("executable", { PATH: unrelated + ":" + root }),
      executable,
      "simple-name PATH search must still resolve executable regular files",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("6. simple-name non-executable, directory and missing remain rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-resolve-bin-abs-"))
  try {
    const plain = join(root, "plain")
    const directory = join(root, "directory")
    await writeFile(plain, "not executable\n")
    await chmod(plain, 0o644)
    await mkdir(directory, { mode: 0o755 })

    assert.equal(
      resolveBinary("plain", { PATH: root }),
      null,
      "a non-executable file on PATH must not resolve",
    )
    assert.equal(
      resolveBinary("directory", { PATH: root }),
      null,
      "a directory on PATH must not resolve",
    )
    assert.equal(
      resolveBinary("missing", { PATH: root }),
      null,
      "a missing name on PATH must not resolve",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
