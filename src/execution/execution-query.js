import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { createExecutionController } from "./execution.js"
import { isValidatedHistoricalTerminal } from "./historical-terminal.js"
export async function findWuExecution(projectRoot, wuId) {
  const dir = join(projectRoot, ".harness/execution/controller")
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) }
  catch (error) { if (error.code === "ENOENT") return null; throw error }
  const matches = []
  for (const e of entries.filter(e => e.isDirectory())) {
    const controller = await createExecutionController({ dir: join(dir, e.name) })
    let state
    try { ({ state } = await controller.snapshot()) }
    catch (error) {
      if (await isValidatedHistoricalTerminal(join(dir, e.name), error)) continue
      throw error
    }
    if (!state.completed && state.wu?.wu_id === wuId && !state.wu.completed) matches.push({ execution_id: e.name, state, controller })
  }
  if (matches.length > 1) throw new Error("Ambiguous active WU execution")
  return matches[0] ?? null
}
