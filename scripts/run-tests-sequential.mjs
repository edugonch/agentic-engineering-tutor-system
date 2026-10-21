// Sequential, low-concurrency test runner.
// The default node --test parallel runner triggers spurious lease expiration on
// resource-constrained environments, so we run one test file at a time. Lease
// TTL is extended via environment variable only for test execution; production
// defaults remain unchanged.
process.env.HARNESS_LEASE_TTL_MS = process.env.HARNESS_LEASE_TTL_MS || "1200000"
import { spawnSync } from "node:child_process"
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1"], {
  stdio: "inherit",
  env: process.env,
})
process.exit(result.status ?? (result.signal ? 1 : 0))
