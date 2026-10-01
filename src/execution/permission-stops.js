// Write-ahead facts, not execution authority. A permission denial must survive
// even if its later BLOCK append loses the lease/CAS race. This immutable inbox
// only restricts admission. Events remain the canonical lifecycle ledger.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stableHash, stableSerialize } from './serialize.js'
import { atomicWriteDurable } from './fsync.js'
import { TERMINAL_BLOCKER_CLASSES } from './constants.js'

export async function readPermissionStops(dir, state) {
  let records
  try { records = JSON.parse(await readFile(join(dir, 'permission-stops.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  if (!Array.isArray(records)) throw new Error('Invalid permission stop inbox.')
  for (const r of records) {
    if (r.id !== stableHash(r.fact) || r.fact.class !== 'BLOCKED_PERMISSION' ||
        r.fact.wu_id !== state.mandate?.repair_policy?.wu_id ||
        r.fact.mandate_revision !== state.mandate?.mandate_revision ||
        r.fact.mandate_id !== state.mandate?.mandate_id) throw new Error('Permission stop integrity/authority binding mismatch.')
  }
  if (new Set(records.map(r => r.id)).size !== records.length) throw new Error('Duplicate permission stop fact.')
  return records
}

// Caller holds the controller mutex. Denial observations need no execution
// lease: they cannot launch, approve, clear a blocker or spend/reset budget.
export async function writePermissionStop(dir, state, { session_id, identity }) {
  if (!state.mandate?.repair_policy || !session_id) throw new Error('A governed permission observation requires an existing Phase 4 binding.')
  const fact = {
    class: 'BLOCKED_PERMISSION', wu_id: state.mandate.repair_policy.wu_id,
    mandate_id: state.mandate.mandate_id, mandate_revision: state.mandate.mandate_revision,
    session_id, identity,
  }
  const record = { id: stableHash(fact), fact }
  const records = await readPermissionStops(dir, state)
  if (!records.some(r => r.id === record.id)) {
    await atomicWriteDurable(join(dir, 'permission-stops.json'), stableSerialize([...records, record]) + '\n')
  }
  return { record, operation: permissionStopOperation(record) }
}

export function permissionStopOperation(record) {
  return { operation_id: `runtime-stop:${record.id}`, operation_type: 'BLOCK', body: {
    blocker_id: `runtime-stop:${record.id}`, class: 'BLOCKED_PERMISSION',
    reason: 'permission.rejected: no alternate execution permitted',
    failure_signature: stableHash(record.fact.identity), origin_session_id: record.fact.session_id,
    evidence: { source: 'OpenCode runtime', permission_stop_id: record.id, identity: record.fact.identity },
  } }
}

export function effectiveBlocker(state, stops) {
  if (state.blocker && TERMINAL_BLOCKER_CLASSES.has(state.blocker.class)) return state.blocker
  return stops.length ? { ...permissionStopOperation(stops[0]).body, pending_log_reconciliation: true } : state.blocker
}

export function assertPermissionAdmission(stops, operation) {
  if (!stops.length) return
  if (['DISPATCH_FINISH', 'DISPATCH_RECONCILE', 'DISPATCH_RELEASE', 'DISPATCH_MARK_AMBIGUOUS'].includes(operation.operation_type)) return
  if (operation.operation_type === 'CHECKPOINT' && !operation.body?.launch_claim && !operation.body?.recovery_action_claim && !operation.body?.recovery_action_evidence) return
  if (stops.some(r => stableSerialize(permissionStopOperation(r)) === stableSerialize(operation))) return
  throw new Error('BLOCKED_PERMISSION: durable permission rejection forbids governed progress, including before BLOCK reconciliation.')
}
