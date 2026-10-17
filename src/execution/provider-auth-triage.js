// Read-only, fail-closed provider authentication triage.
// Historical BLOCKED_TOOLING reasons are advisory text, not authenticated proof.
// No recovery is authorized by this classifier.
const terminal = new Set(["result_reconciled", "released"])
const authError = /\bprovider\.auth\b|\b(?:api\s*key|credential|token)\s+(?:has\s+)?expired\b/i

export function inspectProviderAuthBlocker(state) {
  const blocker = state?.blocker
  if (!blocker || blocker.class !== "BLOCKED_TOOLING") {
    return { status: "NOT_AUTH_RELATED", can_clear: false }
  }

  const typed = blocker.kind === "PROVIDER_AUTH"
  const historical = authError.test(String(blocker.reason ?? ""))
  if (!typed && !historical) {
    return { status: "NOT_AUTH_RELATED", can_clear: false, blocked_at_revision: blocker.at_revision }
  }

  const dispatches = Object.entries(state.dispatches ?? {})
    .filter(([, dispatch]) => dispatch.wu_id === state.wu?.wu_id &&
      (dispatch.expected_agent === "harness-builder" || dispatch.expected_agent === "harness-reviewer"))
    .map(([dispatch_id, dispatch]) => ({ dispatch_id,
      status: dispatch.status, terminal: terminal.has(dispatch.status),
      role: dispatch.expected_agent,
      has_child_identity: Boolean(dispatch.session_id),
      has_handoff: Boolean(dispatch.handoff?.content_hash),
    }))
  const terminalDispatches = dispatches.filter(dispatch => dispatch.terminal)
  const unfinished = dispatches.filter(dispatch => !dispatch.terminal)

  return {
    status: typed && blocker.dispatch_id && terminalDispatches.some(dispatch => dispatch.dispatch_id === blocker.dispatch_id) &&
      unfinished.length === 0 ? "ELIGIBLE_FOR_PROBE" : "EVIDENCE_REQUIRED",
    can_clear: false,
    blocker_kind: typed ? "PROVIDER_AUTH" : "LEGACY_AUTH_TEXT",
    blocked_at_revision: blocker.at_revision,
    active_wu_id: state.wu?.wu_id ?? null,
    dispatches,
    missing: [
      ...(!state.wu || state.wu.completed ? ["active_work_unit"] : []),
      ...(terminalDispatches.length ? [] : ["terminal_builder_or_reviewer_dispatch"]),
      ...(unfinished.length ? ["unsettled_dispatch"] : []),
      ...(!typed ? ["typed_error_identity_not_available_in_legacy_record"] : []),
      "live_provider_auth_canary",
      "fresh_model_and_backend_binding",
    ],
    next_action: "Verify the real provider and exact worker model outside the WU. Do not use setup-timeout retry, clear a blocker from text alone, or reuse a reconciled dispatch.",
  }
}
