// Shared Phase-4 controller-mutation authority predicate.
//
// A Phase-4 mandate binds exactly one controller session. Any other session is a
// specialist descendant and must never execute a mutating controller action.
//
// This single predicate is used in two places so there is exactly one authority
// model:
//   1. the OpenCode runtime guard (early admission optimization for recognized
//      Code Mode wrappers and direct calls), and
//   2. the actual `harness_execution_controller` tool boundary (the authoritative,
//      transport-independent backstop).
//
// Because the backstop runs at the real tool, an unrecognized wrapper, alias or
// any Code Mode variation that still reaches the controller is denied before
// runExecutionController() and before lease acquisition.

export const CONTROLLER_READ_ACTIONS = new Set(['status', 'recover', 'verify'])

export function isControllerReadAction(action) {
  return CONTROLLER_READ_ACTIONS.has(String(action))
}

export function controllerMutationDenied(state, sessionID, action) {
  const controller = state?.mandate?.controller_session_id
  if (!controller) return false
  return sessionID !== controller && !isControllerReadAction(action)
}

export function assertControllerMutationAuthority(state, sessionID, action) {
  if (controllerMutationDenied(state, sessionID, action)) {
    throw new Error('Specialist cannot mutate execution authority.')
  }
}
