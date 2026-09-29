// Append-only durable event log. Events are the canonical commit point; every
// projection (state, budget, dispatches, candidates) is rebuilt from them.

import { readFile } from "node:fs/promises"
import { atomicWriteDurable } from "./fsync.js"

export async function readLog(logPath) {
  let raw
  try {
    raw = await readFile(logPath, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  if (!raw.trim()) return []
  return raw.trim().split(/\r?\n/).map((line) => JSON.parse(line))
}

export function validateLog(events) {
  events.forEach((event, index) => {
    const expected = index + 1
    if (event.sequence !== expected) {
      throw new Error(`Event log sequence gap: expected ${expected}, got ${event.sequence}.`)
    }
    if (!event.event_id || !event.operation_id || !event.operation_type || !Number.isSafeInteger(event.previous_revision) || !Number.isSafeInteger(event.next_revision)) {
      throw new Error(`Malformed event at sequence ${event.sequence}.`)
    }
  })
  return events
}

export async function writeLog(logPath, events) {
  validateLog(events)
  const data = events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "")
  await atomicWriteDurable(logPath, data)
}
