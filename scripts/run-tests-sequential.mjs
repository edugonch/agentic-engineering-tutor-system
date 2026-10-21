process.env.HARNESS_LEASE_TTL_MS = process.env.HARNESS_LEASE_TTL_MS || "1200000"
// Sequential test runner: runs each *.test.js file in its own node --test process.
// The default node --test parallel runner triggers spurious lease expiration on
// this environment when many controller tests compete, so we run files one at a
// time while still letting Node run a file's own subtests concurrently.
import { execSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile() && entry.name.endsWith('.test.js')) yield path
  }
}

const files = []
for await (const f of walk('tests')) files.push(f)
files.sort()

let failed = false
for (const file of files) {
  console.log(`\n=== ${file} ===`)
  try {
    execSync(`node --test "${file}"`, { stdio: 'inherit', timeout: 300000 })
  } catch (err) {
    failed = true
    process.exitCode = err.status || 1
  }
}
if (failed) process.exit(process.exitCode || 1)
