import { stableHash } from './serialize.js'

export function expiredWait(state, operation) {
  const wait = state.external_wait_history?.at(-1)
  if (state.blocker?.class !== 'BLOCKED_EXTERNAL_FACT' || wait?.outcome !== 'EXPIRED' || (operation && wait.operation !== operation)) return null
  if (wait.ended_at_revision !== undefined && state.blocker.at_revision !== wait.ended_at_revision) return null
  const reason = `${wait.operation}: ${wait.kind} did not recover before ${wait.deadline_at}. Last observation: ${wait.reason}`
  return state.blocker.reason === reason ? wait : null
}
// A terminal remote observation only authorizes leaving the timeout. The merge
// path must still re-read the exact PR and enforce ordinary merge gates.
export function terminalObservation(state, operation, observation) {
  const binding = state.pr_binding
  if (!binding || !['harness_merge_candidate:', 'harness_verify_external_merge:'].some(prefix => operation === prefix + binding.candidate_id) ||
      stableHash(observation?.binding) !== stableHash(binding) || !observation?.pr) return false
  // The exact PR observation shows the remote API is available again. It
  // retires only the transient wait; ordinary head/base/tree/merge gates are
  // still applied after it. GitHub Actions conclusions have no authority.
  const pr = observation.pr
  return typeof pr.state === 'string' && typeof pr.head_sha === 'string' &&
    typeof pr.base_sha === 'string'
}
