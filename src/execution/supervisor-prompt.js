// Deterministic supervisor continuation guidance. Kept separate from the
// scheduler so runtime waits never trigger expensive model-generated planning.
// These are instructions, not authorization; the controller owns every write.
import { expiredWait } from "./external-observation.js"
import { routeExecution } from "./workflow-router.js"

const base = "Preserve exact owner authority, scope, budget, permissions and durable evidence. Never invent PASS, a terminal child, CI success or a new WU. Runtime completion is not acceptance."

export function composeSupervisorPrompt({
  execution, state, toolingTriage = false, contractTriage = false,
  scopeTriage = false, unsettled = false,
}) {
  if (scopeTriage) return [
    `One bounded stale-worktree scope recovery triage for execution ${execution}, blocker at revision ${state.blocker.at_revision}.`,
    "Use inspect_scope_worktree; reconcile_stale_worktree_scope only after the previous merged HEAD, frozen hashes and absence of tracked drift are proven. Never change functional WU scope, clear unrelated blockers or bypass the journal.",
    base,
  ].join(" ")
  if (contractTriage) return [
    `Next frozen Work Unit technical contract is incomplete for execution ${execution}; blocker revision ${state.blocker.at_revision}.`,
    "Read status/verify and inspect_next_wu_contract. Derive_and_stage_next_wu_contract only from the exact frozen DRAFT under the approved mandate and time policy, then activate the staged WU. Never invent business approval or expand the sequence.",
    base,
  ].join(" ").replace("Derive_and_stage_next_wu_contract", "derive_and_stage_next_wu_contract")
  if (toolingTriage) return [
    `One-time tooling diagnosis for execution ${execution}, blocker at revision ${state.blocker.at_revision}.`,
    "Read exact runtime/source facts and existing recovery audit once. harness_retry_blocked_verification applies ONLY to a frozen setup-timeout FAIL receipt, never to an undeclared setup command. Otherwise remain read-only and clear only independently repaired causes.",
    "Never start a new WU, reserve or launch a dispatch during this tooling diagnostic; preserve the blocker if proof is missing.",
    base,
  ].join(" ")
  const route = routeExecution(state)
  const wait = expiredWait(state)
  const task = wait
    ? `Observe the remote condition for expired wait ${wait.operation}; recovery is observational until genuine terminal evidence exists.`
    : state.external_wait
      ? `The external wait is due: observe/retry ${state.external_wait.operation} without assuming remote success.`
      : unsettled
        ? "Inspect/recover the existing dispatch before any new work."
        : `Follow the one next safe action ${route.nextAction} from the durable operational status.`
  return [
    `Continue execution ${execution} from operational_status first; read full status/verify only for exact evidence gates.`,
    task, base, "Continue already-authorized work without requesting repeated owner approval; stop only on an unresolved real blocker or completion.",
  ].join(" ")
}
