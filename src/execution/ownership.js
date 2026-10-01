// Project-wide ownership is derived from canonical controller logs, under one
// short project mutex. No second counter database or crash-prone dual write.
import { readdir } from 'node:fs/promises'
import { join, basename, dirname, resolve } from 'node:path'
import { readLog, validateLog } from './event-log.js'
import { project } from './state.js'
import { readPermissionStops, effectiveBlocker } from './permission-stops.js'

export function controllerDirectory(dir) {
  return basename(dirname(resolve(dir))) === 'controller' ? dirname(resolve(dir)) : null
}

export async function controllerStates(directory) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const result = []
  for (const e of entries) {
    if (e.isSymbolicLink()) throw new Error('Unsafe controller directory.')
    if (!e.isDirectory()) continue
    const dir = join(directory, e.name)
    const events = validateLog(await readLog(join(dir, 'events.ndjson')))
    if (events.length) {
      let state
      try { state = project(events) }
      catch (error) {
        // Only structurally valid, explicitly pre-Phase-4 history can be
        // isolated. Unknown/corrupt logs and any Phase-4 authority fail closed.
        if (events.some(e => e.body?.repair_policy !== undefined)) throw error
        if ((await readPermissionStops(dir, {})).length) throw error
        const values = key => [...new Set(events.map(e => e.body?.[key]).filter(Boolean))]
        result.push({ dir, state: null, projection_error: String(error.message), legacy_bindings: {
          session_ids: [...values('session_id'), ...values('controller_session_id')],
          wu_ids: values('wu_id'), mandate_ids: values('mandate_id'), artifact_ids: values('source_artifact_id'),
        } })
        continue
      }
      const stops = await readPermissionStops(dir, state)
      result.push({ dir, state, effective_blocker: effectiveBlocker(state, stops) })
    }
  }
  return result
}

export async function assertOwnership(directory, execDir, state, operation) {
  const b = operation.body ?? {}
  const policy = state.mandate?.repair_policy ?? b.repair_policy
  if (policy && !directory) throw new Error('Phase 4 requires a project controller directory for durable WU ownership.')
  if (!directory) return
  const mandate = operation.operation_type === 'MANDATE_APPROVE' ? b : state.mandate
  const wu = policy?.wu_id ?? state.wu?.wu_id ?? (operation.operation_type === 'WU_ACTIVATE' ? b.wu_id : null)
  for (const peer of await controllerStates(directory)) {
    if (resolve(peer.dir) === resolve(execDir)) continue
    if (peer.projection_error) {
      const b = peer.legacy_bindings
      if ((wu && b.wu_ids.includes(wu)) || b.mandate_ids.includes(mandate?.mandate_id) || b.artifact_ids.includes(mandate?.source_artifact_id)) {
        throw new Error(`Historical projection failure affects this authority: ${basename(peer.dir)}: ${peer.projection_error}`)
      }
      continue
    }
    if (!policy && !peer.state.mandate?.repair_policy) continue
    const m = peer.state.mandate
    if ((wu && (m?.repair_policy?.wu_id === wu || peer.state.activated_wu_ids.includes(wu))) ||
        (mandate?.source_artifact_id && mandate.source_artifact_id === m?.source_artifact_id) ||
        (mandate?.mandate_id && mandate.mandate_id === m?.mandate_id)) {
      throw new Error(`WU/mandate ownership is durably bound to ${basename(peer.dir)}; changing execution_id cannot reset authority or limits.`)
    }
  }
}
