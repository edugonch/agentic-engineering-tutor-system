import { join } from "node:path"
import { readLog, validateLog } from "./event-log.js"

// Narrow exception for an obsolete terminal event, not a general permission to
// skip broken logs. A malformed, live, or ambiguous execution must still stop
// launch discovery (fail-closed).
const POST_COMPLETE_AUDIT = new Set([
  "CHECKPOINT", "DISPATCH_RECONCILE", "DISPATCH_FINISH",
  "DISPATCH_USAGE", "DISPATCH_HANDOFF", "DISPATCH_RELEASE",
])
export async function isValidatedHistoricalTerminal(dir, projectionError) {
  if (!/^COMPLETE blocked: /.test(projectionError?.message ?? "")) return false
  let events
  try { events = validateLog(await readLog(join(dir, "events.ndjson"))) }
  catch { return false }
  // validateLog enforces event hashes; require full monotonic revisions too.
  if (!events.every((e, i) => e.previous_revision === i && e.next_revision === i + 1)) return false
  const index = events.findLastIndex(e => e.operation_type === "COMPLETE")
  if (index === -1) return false
  return events.slice(index + 1).every(e => POST_COMPLETE_AUDIT.has(e.operation_type))
}
