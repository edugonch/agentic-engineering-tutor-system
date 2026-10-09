import { stableHash } from './serialize.js'

export function expiredWait(state, operation) {
  const wait = state.external_wait_history?.at(-1)
  if (state.blocker?.class !== 'BLOCKED_EXTERNAL_FACT' || wait?.outcome !== 'EXPIRED' || (operation && wait.operation !== operation)) return null
  if (wait.ended_at_revision !== undefined && state.blocker.at_revision !== wait.ended_at_revision) return null
  const reason = `${wait.operation}: ${wait.kind} did not recover before ${wait.deadline_at}. Last observation: ${wait.reason}`
  return state.blocker.reason === reason ? wait : null
}
// A terminal remote observation only authorizes leaving the timeout. The merge
// path must still re-read the PR/checks and enforce every ordinary gate.
export function terminalObservation(state, operation, observation) {
  const binding = state.pr_binding
  if (!binding || !['harness_merge_candidate:', 'harness_verify_external_merge:'].some(prefix => operation === prefix + binding.candidate_id) ||
      stableHash(observation?.binding) !== stableHash(binding) || !observation?.pr || !Array.isArray(observation.checks)) return false
  const pr = observation.pr
  if (pr.head_sha !== binding.head_sha || pr.base_sha !== binding.base_sha || pr.state !== 'open' || pr.merged) return true // drift/failure is diagnosed by the normal gate
  const required = state.mandate?.required_ci_checks ?? []
  return required.every(name => {
    const c = observation.checks.find(check => check.name === name)
    return c && !c.pending && ['SUCCESS', 'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'NEUTRAL', 'SKIPPED', 'STALE', 'STARTUP_FAILURE', 'ERROR'].includes(String(c.conclusion).toUpperCase())
  })
}
