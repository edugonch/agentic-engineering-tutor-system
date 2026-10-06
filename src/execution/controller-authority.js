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
export const CONTROLLER_TRANSFER_ACTIONS = new Set(['transfer_controller'])

export function isControllerReadAction(action) {
  return CONTROLLER_READ_ACTIONS.has(String(action))
}

export function isControllerTransferAction(action) {
  return CONTROLLER_TRANSFER_ACTIONS.has(String(action))
}

export function controllerMutationDenied(state, sessionID, action) {
  const controller = state?.mandate?.controller_session_id
  if (!controller) return false
  // Controller transfer is admitted through the early guard and the tool
  // boundary; its real preconditions (owner authorization, expected old
  // controller, expected revision, lease expiry, dispatch safety, etc.) are
  // validated at commit time inside runExecutionController / applyEvent.
  if (isControllerTransferAction(action)) return false
  return sessionID !== controller && !isControllerReadAction(action)
}

export function assertControllerMutationAuthority(state, sessionID, action) {
  if (controllerMutationDenied(state, sessionID, action)) {
    throw new Error('Specialist cannot mutate execution authority.')
  }
}
