import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { createExecutionController } from "./execution.js"
export async function findWuExecution(projectRoot, wuId) {
  const dir = join(projectRoot, ".harness/execution/controller")
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) }
  catch (error) { if (error.code === "ENOENT") return null; throw error }
  const matches = []
  for (const e of entries.filter(e => e.isDirectory())) {
    const controller = await createExecutionController({ dir: join(dir, e.name) })
    const { state } = await controller.snapshot()
    if (!state.completed && state.wu?.wu_id === wuId && !state.wu.completed) matches.push({ execution_id: e.name, state, controller })
  }
  if (matches.length > 1) throw new Error("Ambiguous active WU execution")
  return matches[0] ?? null
}
