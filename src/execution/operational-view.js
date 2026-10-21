// Presentation only. The controller's event log is the sole authority.
const LIVE = new Set(["reserved", "pending_launch", "launched", "ambiguous", "abandoned"]);
const known = value => value === undefined || value === null ? "UNKNOWN" : value;

export function projectOperationalView(state) {
  const wu = state.wu && !state.wu.completed ? state.wu : null;
  const wuId = wu?.wu_id ?? null;
  const sequence = Array.isArray(state.mandate?.wu_sequence) ? state.mandate.wu_sequence : [];
  const activated = new Set(state.activated_wu_ids ?? []);
  const nextWuId = sequence.find(id => !activated.has(id)) ?? null;
  const candidates = Object.entries(state.candidates ?? {})
    .filter(([, c]) => c.wu_id === wuId && !c.superseded_by_contract);
  const candidateId = wuId ? candidates.at(-1)?.[0] ?? null : null;
  const review = candidateId ? state.reviews?.[candidateId] : null;
  const changeRequests = wuId ? Object.entries(state.reviews ?? {}).reduce((n, [id, current]) => {
    if (state.candidates?.[id]?.wu_id !== wuId) return n;
    return n + [current, ...(state.review_history?.[id] ?? [])]
      .filter(r => r?.verdict === "CHANGES_REQUIRED").length;
  }, 0) : 0;
  const dispatches = Object.entries(state.dispatches ?? {}).filter(([, d]) => wuId && d.wu_id === wuId);
  const active = dispatches.filter(([, d]) => LIVE.has(d.status));
  const latestSession = agent => known(dispatches.filter(([, d]) => d.expected_agent === agent).at(-1)?.[1].session_id);
  const reviewerActive = active.some(([, d]) => d.expected_agent === "harness-reviewer");
  const builderActive = active.some(([, d]) => d.expected_agent === "harness-builder");
  const ambiguous = active.some(([, d]) => ["ambiguous", "abandoned"].includes(d.status));
  const budget = state.budget ?? {};
  const budgetRemaining = [budget.total_seconds, budget.used_seconds, budget.reserved_seconds]
    .every(Number.isFinite)
    ? Math.max(0, budget.total_seconds - budget.used_seconds - budget.reserved_seconds)
    : "UNKNOWN";

  let phase, nextAction;
  if (state.completed) {
    phase = "DONE"; nextAction = "NONE";
  } else if (state.blocker) {
    phase = "BLOCKED"; nextAction = "DIAGNOSE_ONCE_OR_STOP";
  } else if (state.mandate?.authority_kind !== "OWNER_APPROVED_EPIC") {
    phase = "BLOCKED"; nextAction = "REQUIRE_APPROVED_EPIC";
  } else if (ambiguous) {
    phase = "BLOCKED"; nextAction = "INSPECT_EXISTING_DISPATCH_ONCE";
  } else if (state.verification_phase) {
    phase = "VERIFYING"; nextAction = "OBSERVE_EXISTING_VERIFICATION";
  } else if (reviewerActive) {
    phase = "REVIEWING"; nextAction = "AWAIT_INDEPENDENT_REVIEW";
  } else if (builderActive) {
    phase = "BUILDING"; nextAction = "AWAIT_EXISTING_BUILDER";
  } else if (active.length) {
    // Legacy dispatch without an agent binding is still live; never launch over it.
    phase = "BLOCKED"; nextAction = "INSPECT_EXISTING_DISPATCH_ONCE";
  } else if (budgetRemaining === 0) {
    phase = "BLOCKED"; nextAction = "STOP_EPIC_BUDGET";
  } else if (!wu) {
    phase = "READY";
    nextAction = nextWuId ? "ACTIVATE_NEXT_APPROVED_WU" : "CHECK_EPIC_TERMINAL_CONDITION";
  } else if (review?.verdict === "BLOCKED") {
    phase = "BLOCKED"; nextAction = "DIAGNOSE_ONCE_OR_STOP";
  } else if (review?.verdict === "CHANGES_REQUIRED") {
    phase = changeRequests > 2 ? "BLOCKED" : "REPAIRING";
    nextAction = changeRequests > 2 ? "STOP_REPAIR_LIMIT" : "REPAIR_SAME_WU";
  } else if (review?.verdict === "PASS") {
    phase = "MERGING";
    nextAction = state.mandate?.merge_policy === "none" ||
      (state.merge?.status === "VERIFIED" && state.merge?.candidate_id === candidateId)
      ? "COMPLETE_WU" : state.mandate?.merge_policy === "human"
        ? "WAIT_FOR_AUTHORIZED_EXTERNAL_MERGE" : "APPLY_GOVERNED_MERGE_GATES";
  } else if (candidateId) {
    phase = "VERIFYING"; nextAction = "VERIFY_THEN_INDEPENDENT_REVIEW";
  } else {
    phase = "BUILDING"; nextAction = "LAUNCH_ONE_BUILDER";
  }
  return {
    execution_id: state.execution_id, revision: state.revision,
    epic_id: known(state.mandate?.mandate_id), wu_id: known(wuId),
    next_wu_id: known(nextWuId), phase,
    builder_session_id: latestSession("harness-builder"),
    reviewer_session_id: latestSession("harness-reviewer"),
    candidate_id: known(candidateId),
    verification: review?.verdict === "PASS" ? "PASS" : "UNKNOWN",
    review: known(review?.verdict),
    ci: "UNKNOWN", // Exact-head CI is external evidence; do not invent a result.
    change_requests_seen: changeRequests,
    repair_rounds_used: "UNKNOWN", // Not an authoritative durable attempt counter.
    budget_remaining_seconds: budgetRemaining,
    merge_policy: known(state.mandate?.merge_policy),
    blocker: state.blocker ? { class: state.blocker.class, at_revision: state.blocker.at_revision } : null,
    next_action: nextAction,
  };
}
