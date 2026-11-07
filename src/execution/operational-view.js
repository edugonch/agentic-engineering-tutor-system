// Read-only public projection. Routing is centralized in workflow-router;
// the event journal and controller remain the sole source of authority.
import { routeExecution } from "./workflow-router.js"

const known = value => value === undefined || value === null ? "UNKNOWN" : value

export function projectOperationalView(state, { events = [] } = {}) {
  const route = routeExecution(state, { events })
  return {
    execution_id: state.execution_id, revision: state.revision,
    epic_id: known(state.mandate?.mandate_id), wu_id: known(route.wuId),
    next_wu_id: known(route.nextWuId), phase: route.phase,
    builder_session_id: known(route.builderSessionId),
    reviewer_session_id: known(route.reviewerSessionId),
    candidate_id: known(route.candidateId),
    verification: route.review?.verdict === "PASS" ? "PASS" : "UNKNOWN",
    review: known(route.review?.verdict),
    unsettled_dispatch_count: route.unsettledCount,
    ci: "UNKNOWN", // Exact-head CI is external evidence; do not invent a result.
    change_requests_seen: route.changeRequests,
    repair_rounds_used: "UNKNOWN", // Not an authoritative durable attempt counter.
    budget_remaining_seconds: route.budgetRemaining,
    merge_policy: known(state.mandate?.merge_policy),
    blocker: state.blocker ? { class: state.blocker.class, at_revision: state.blocker.at_revision } : null,
    next_action: route.nextAction,
  }
}
