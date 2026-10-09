// Read-only compatibility/migration preflight. Never acquires a lease or writes.
import { resolve, join } from "node:path"
import { readLog, validateLog } from "../src/execution/event-log.js"
import { project, deriveBudget } from "../src/execution/state.js"
import { wuBudgetUsage } from "../src/execution/wu-budget.js"
import { recoveryAction } from "../src/execution/progress.js"
const [projectPath, executionID] = process.argv.slice(2)
if (!projectPath || !executionID || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(executionID)) {
  console.error("Usage: node scripts/inspect-execution.mjs PROJECT_PATH EXECUTION_ID")
  process.exit(2)
}
try {
  const path = join(resolve(projectPath), ".harness/execution/controller", executionID, "events.ndjson")
  const events = validateLog(await readLog(path))
  if (!events.length) throw new Error("Execution log is missing or empty")
  const state = project(events)
  console.log(JSON.stringify({ read_only: true, integrity: "PASS", revision: state.revision,
    hash_versions: [...new Set(events.map(e => e.operation_hash_version ?? 1))],
    budget: deriveBudget(state.budget), wu_budget: state.wu ? wuBudgetUsage(state, state.wu.wu_id) : null,
    contract: state.wu?.contract ? { hash: state.wu.contract.contract_hash, normalization_required: state.wu.contract.normalization_required } : "LEGACY_UNBOUND",
    next_action: recoveryAction(state), unresolved_dispatches: Object.entries(state.dispatches)
      .filter(([, d]) => !["released", "result_reconciled"].includes(d.status))
      .map(([id, d]) => ({ dispatch_id: id, status: d.status, session_id: d.session_id, reservation_seconds: d.reserved_seconds })),
    migration: "Use supported controller transitions only. No charge refunds, blocker edits or state rewrites are implied.",
  }, null, 2))
} catch (error) { console.error(error.message); process.exitCode = 1 }
