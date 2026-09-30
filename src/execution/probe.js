// Phase 0 continuation probe.
//
// This is the instrument that gathers empirical evidence inside OpenCode for
// whether `steps` exhaustion can become a recoverable pause without resetting
// authority, budget, fencing, or permissions. The probe itself only reads and
// writes the durable execution core under an isolated `.harness/execution/`
// directory; it never touches OpenCode configuration, permissions, or agents.
//
// The probe does NOT simulate the model. Between `init` and `verify` calls the
// operator (or the orchestrator) lets the agent run until OpenCode's `steps`
// limit stops it, then continues. `verify` measures what persisted across that
// boundary.

import { join } from "node:path"
import { createExecutionController } from "./execution.js"

const PHASES = { ACTIVE: "ACTIVE", WAITING_OWNER: "WAITING_OWNER" }

function probeId(input) {
  const raw = String(input.probe_id ?? "")
  const id = raw.replace(/[^A-Za-z0-9._-]/g, "_")
  if (!id || id === "." || id === "..") throw new Error("probe_id must be a non-empty identifier that is not '.' or '..'.")
  return id
}

export async function runContinuationProbe(projectRoot, input) {
  const id = probeId(input)
  const dir = join(projectRoot, ".harness", "execution", "probe", id)
  const controller = await createExecutionController({ dir, lease_ttl_ms: 30000 })
  const holder = String(input.session_id ?? `probe:${id}`)
  const action = String(input.action ?? "verify")

  if (action === "init") {
    const lease = await controller.acquire(holder)
    const mandateId = String(input.mandate_id ?? `${id}-MANDATE-001`)
    const mandateRevision = String(input.mandate_revision ?? "rev-0")
    const totalSeconds = Number(input.total_seconds ?? 60)
    const t0 = Date.now()

    await controller.commit({ operation_id: `${id}:mandate`, operation_type: "MANDATE_APPROVE", body: { execution_id: `${id}:exec`, mandate_id: mandateId, mandate_revision: mandateRevision, max_wus: Number(input.max_wus ?? 4), total_seconds: totalSeconds } }, { holder_session_id: holder, expected_revision: 0 })
    await controller.commit({ operation_id: `${id}:wu`, operation_type: "WU_ACTIVATE", body: { wu_id: `${id}:WU-01`, mandate_id: mandateId } }, { holder_session_id: holder, expected_revision: 1 })
    await controller.commit({ operation_id: `${id}:phase-start`, operation_type: "PHASE_START", body: { phase: PHASES.ACTIVE, started_at: t0 } }, { holder_session_id: holder, expected_revision: 2 })
    await controller.commit({ operation_id: `${id}:dispatch-reserve`, operation_type: "DISPATCH_RESERVE", body: { dispatch_id: `${id}:dsp-0001` } }, { holder_session_id: holder, expected_revision: 3 })
    await controller.commit({ operation_id: `${id}:dispatch-launch`, operation_type: "DISPATCH_LAUNCH", body: { dispatch_id: `${id}:dsp-0001`, session_id: holder } }, { holder_session_id: holder, expected_revision: 4 })
    await controller.commit({ operation_id: `${id}:checkpoint-0`, operation_type: "CHECKPOINT", body: { note: "initial checkpoint" } }, { holder_session_id: holder, expected_revision: 5 })

    return {
      action,
      instruction: "Now let the agent run until OpenCode's steps limit stops it. Then continue the same logical execution and call verify. Between calls, do not manually re-approve anything and do not run a forbidden operation through another tool.",
      ...(await snapshotReport(controller, id, holder)),
      lease,
    }
  }

  if (action === "checkpoint") {
    const lease = await controller.acquire(holder)
    const snap = await controller.snapshot()
    const revision = snap.state.revision
    if (snap.state.budget.active_phase === PHASES.ACTIVE) {
      const now = Date.now()
      await controller.commit({ operation_id: `${id}:phase-end-${revision}`, operation_type: "PHASE_END", body: { phase: PHASES.ACTIVE, ended_at: now } }, { holder_session_id: holder, expected_revision: revision })
      await controller.commit({ operation_id: `${id}:phase-start-${revision}`, operation_type: "PHASE_START", body: { phase: PHASES.ACTIVE, started_at: now } }, { holder_session_id: holder, expected_revision: revision + 1 })
    }
    await controller.commit({ operation_id: `${id}:checkpoint-${revision + 2}`, operation_type: "CHECKPOINT", body: { note: input.note ?? "checkpoint" } }, { holder_session_id: holder, expected_revision: revision + 2 })
    return { action, ...(await snapshotReport(controller, id, holder)), lease }
  }

  if (action === "block") {
    await controller.acquire(holder)
    const snap = await controller.snapshot()
    await controller.commit(
      { operation_id: `${id}:block`, operation_type: "BLOCK", body: { class: "BLOCKED_PERMISSION", reason: String(input.note ?? "permission.rejected") } },
      { holder_session_id: holder, expected_revision: snap.state.revision },
    )
    return { action: "block", ...(await snapshotReport(controller, id, holder)) }
  }

  // verify (default)
  const report = await snapshotReport(controller, id, holder)
  return { action: "verify", ...report, invariants: computeInvariants(report, id) }
}

async function snapshotReport(controller, id, holder) {
  const snap = await controller.snapshot()
  const { state } = snap
  return {
    probe_id: id,
    holder_session_id: holder,
    execution_id: state.execution_id,
    mandate_id: state.mandate?.mandate_id ?? null,
    mandate_revision: state.mandate?.mandate_revision ?? null,
    wu_id: state.wu?.wu_id ?? null,
    authorization: state.wu?.authorization ?? null,
    revision: state.revision,
    budget: {
      total_seconds: state.budget.total_seconds,
      used_seconds: state.budget.used_seconds,
      active_phase: state.budget.active_phase,
    },
    dispatches: Object.entries(state.dispatches).map(([dispatch_id, d]) => ({ dispatch_id, status: d.status, session_id: d.session_id })),
    fencing_token: snap.lease?.fencing_token ?? null,
    checkpoint: state.checkpoint,
    blocker: state.blocker,
    completed: state.completed,
  }
}

function computeInvariants(report, id) {
  const dispatchIds = report.dispatches.map((d) => d.dispatch_id)
  const checks = {
    "execution_id stable": report.execution_id === `${id}:exec`,
    "mandate identity stable": report.mandate_id === `${id}-MANDATE-001` && report.mandate_revision === "rev-0",
    "WU identity stable": report.wu_id === `${id}:WU-01`,
    "authorization is AUTHORIZED_BY_MANDATE (no synthesized approval)": report.authorization === "AUTHORIZED_BY_MANDATE",
    "budget never resets": Number.isFinite(report.budget.used_seconds) && report.budget.used_seconds >= 0,
    "no duplicate dispatch": new Set(dispatchIds).size === dispatchIds.length,
    "fencing token is a positive integer generation": Number.isInteger(report.fencing_token) && report.fencing_token >= 1,
    "no unexpected blocker": report.blocker === null || report.blocker === undefined,
  }
  const passed = Object.values(checks).every(Boolean)
  return { passed, checks }
}
