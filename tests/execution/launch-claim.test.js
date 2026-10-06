import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyEvent, project } from "../../src/execution/state.js"
import { createExecutionController } from "../../src/execution/execution.js"
import { claimDispatchLaunch } from "../../src/execution/controller-tool.js"
import { stableHash } from "../../src/execution/serialize.js"
import { DISPATCH_STATUS } from "../../src/execution/constants.js"

// --- state-machine helpers (mirror dispatch-reservation.test.js) ---
function makeBuilder() {
  let seq = 0
  return (operation_type, body, extra = {}) => {
    seq += 1
    return {
      sequence: seq,
      event_id: `e${seq}`,
      operation_id: `op-${seq}`,
      operation_type,
      operation_hash: stableHash(body),
      body,
      previous_revision: seq - 1,
      next_revision: seq,
      fencing_token: 1,
      timestamp: "t",
      ...extra,
    }
  }
}

function nextEvent(state, operation_type, body) {
  const seq = state.revision + 1
  return {
    sequence: seq,
    event_id: `e${seq}`,
    operation_id: "op-next",
    operation_type,
    operation_hash: stableHash(body),
    body,
    previous_revision: state.revision,
    next_revision: seq,
    fencing_token: 1,
    timestamp: "t",
  }
}

const MANDATE = { mandate_id: "M1", max_wus: 4, total_seconds: 100 }

// reserve → prepare, optionally with the Wave B launch-intent binding.
function reservePrepare(ev, { dispatch_id = "d1", reserved = 10, claim = false, agent = "harness-reviewer" } = {}) {
  return [
    ev("DISPATCH_RESERVE", { dispatch_id, reserved_seconds: reserved }),
    ev("DISPATCH_PREPARE", claim ? { dispatch_id, prepared_by_session_id: "owner", expected_agent: agent, claim_required: true } : { dispatch_id }),
  ]
}

// --- state-machine tests ---
test("claim_required dispatch requires a durable launch claim before launch", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ...reservePrepare(ev, { claim: true })]
  const s = project(events)
  assert.throws(
    () => applyEvent(s, nextEvent(s, "DISPATCH_LAUNCH", { dispatch_id: "d1", session_id: "ses-1" })),
    /no launch claim/,
  )
})

test("claim then launch reaches LAUNCHED with the recorded identity", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ...reservePrepare(ev, { claim: true }), ev("DISPATCH_LAUNCH_CLAIM", { dispatch_id: "d1", call_id: "call-1" })]
  const s = project(events)
  assert.equal(s.dispatches.d1.launch_call_id, "call-1")
  const s2 = applyEvent(s, nextEvent(s, "DISPATCH_LAUNCH", { dispatch_id: "d1", session_id: "ses-1" }))
  assert.equal(s2.dispatches.d1.status, DISPATCH_STATUS.LAUNCHED)
  assert.equal(s2.dispatches.d1.session_id, "ses-1")
})

test("a second distinct claim is rejected and never overwrites launch_call_id", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ...reservePrepare(ev, { claim: true }), ev("DISPATCH_LAUNCH_CLAIM", { dispatch_id: "d1", call_id: "call-1" })]
  const s = project(events)
  assert.throws(
    () => applyEvent(s, nextEvent(s, "DISPATCH_LAUNCH_CLAIM", { dispatch_id: "d1", call_id: "call-2" })),
    /already claimed/,
  )
  assert.equal(s.dispatches.d1.launch_call_id, "call-1")
})

test("claim requires PENDING_LAUNCH and a non-empty call_id", () => {
  const ev = makeBuilder()
  const reserved = project([ev("MANDATE_APPROVE", MANDATE), ev("DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 10 })])
  assert.throws(() => applyEvent(reserved, nextEvent(reserved, "DISPATCH_LAUNCH_CLAIM", { dispatch_id: "d1", call_id: "call-1" })), /not pending launch/)

  const ev2 = makeBuilder()
  const pending = project([ev2("MANDATE_APPROVE", MANDATE), ...reservePrepare(ev2, { claim: true })])
  assert.throws(() => applyEvent(pending, nextEvent(pending, "DISPATCH_LAUNCH_CLAIM", { dispatch_id: "d1", call_id: "" })), /requires call_id/)
})

test("claimed PENDING_LAUNCH cannot be released; mark_ambiguous is the path", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ...reservePrepare(ev, { claim: true }), ev("DISPATCH_LAUNCH_CLAIM", { dispatch_id: "d1", call_id: "call-1" })]
  const s = project(events)
  assert.throws(
    () => applyEvent(s, nextEvent(s, "DISPATCH_RELEASE", { dispatch_id: "d1" })),
    /launch was claimed|ambiguous/,
  )
  const s2 = applyEvent(s, nextEvent(s, "DISPATCH_MARK_AMBIGUOUS", { dispatch_id: "d1" }))
  assert.equal(s2.dispatches.d1.status, DISPATCH_STATUS.AMBIGUOUS)
})

test("unclaimed PENDING_LAUNCH (guard rejection before subagent) is releasable", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ...reservePrepare(ev, { claim: true })]
  const s = project(events)
  const s2 = applyEvent(s, nextEvent(s, "DISPATCH_RELEASE", { dispatch_id: "d1" }))
  assert.equal(s2.dispatches.d1.status, DISPATCH_STATUS.RELEASED)
})

test("backward-compatible V1 dispatch (no claim_required) launches without a claim", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ...reservePrepare(ev, { claim: false })]
  const s = project(events)
  const s2 = applyEvent(s, nextEvent(s, "DISPATCH_LAUNCH", { dispatch_id: "d1", session_id: "ses-1" }))
  assert.equal(s2.dispatches.d1.status, DISPATCH_STATUS.LAUNCHED)
})

test("legacy dispatch (no claim_required) can never be claimed", () => {
  const ev = makeBuilder()
  const events = [ev("MANDATE_APPROVE", MANDATE), ...reservePrepare(ev, { claim: false })]
  const s = project(events)
  assert.throws(
    () => applyEvent(s, nextEvent(s, "DISPATCH_LAUNCH_CLAIM", { dispatch_id: "d1", call_id: "call-1" })),
    /not prepared with claim_required/,
  )
})

// --- controller-level tests (mirror runExecutionController directory convention) ---
function controllerDir(root, executionId = "E1") {
  return join(root, ".harness", "execution", "controller", executionId)
}

async function commitSteps(controller, holder, token, steps, startRevision = 0) {
  let revision = startRevision
  for (const [operation_id, operation_type, body] of steps) {
    const res = await controller.commit(
      { operation_id, operation_type, body },
      { holder_session_id: holder, expected_revision: revision, lease_fencing_token: token },
    )
    revision = res.revision
  }
  return revision
}

const STEPS = [
  ["mandate", "MANDATE_APPROVE", { mandate_id: "M1", max_wus: 4, total_seconds: 100 }],
  ["res-d1", "DISPATCH_RESERVE", { dispatch_id: "d1", reserved_seconds: 5 }],
  ["prep-d1", "DISPATCH_PREPARE", { dispatch_id: "d1", prepared_by_session_id: "A", expected_agent: "harness-reviewer", claim_required: true }],
  ["claim-d1", "DISPATCH_LAUNCH_CLAIM", { dispatch_id: "d1", call_id: "call-1" }],
  ["res-d2", "DISPATCH_RESERVE", { dispatch_id: "d2", reserved_seconds: 5 }],
  ["prep-d2", "DISPATCH_PREPARE", { dispatch_id: "d2" }],
]

test("recover classifies claimed pending as AMBIGUOUS and unclaimed as NEVER_LAUNCHED, without mutating", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-claim-recover-"))
  try {
    const controller = await createExecutionController({ dir: controllerDir(root), lease_ttl_ms: 30000 })
    const lease = await controller.acquire("A")
    const rev = await commitSteps(controller, "A", lease.fencing_token, STEPS)

    const before = await controller.snapshot()
    const report = await controller.recover()
    const after = await controller.snapshot()

    assert.equal(after.state.revision, before.state.revision) // recover never mutates
    assert.deepEqual(report.classification.ambiguous.sort(), ["d1"])
    assert.deepEqual(report.classification.never_launched.sort(), ["d2"])

    await assert.rejects(
      controller.commit(
        { operation_id: "rel-d1", operation_type: "DISPATCH_RELEASE", body: { dispatch_id: "d1" } },
        { holder_session_id: "A", expected_revision: rev, lease_fencing_token: lease.fencing_token },
      ),
      /launch was claimed|ambiguous/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("claim is replay-idempotent and survives restart/reprojection", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-claim-idem-"))
  try {
    const controller = await createExecutionController({ dir: controllerDir(root), lease_ttl_ms: 30000 })
    const lease = await controller.acquire("A")
    const rev = await commitSteps(controller, "A", lease.fencing_token, STEPS.slice(0, 3)) // mandate + reserve + prepare

    const op = { operation_id: "E1:claim:d1:call-1", operation_type: "DISPATCH_LAUNCH_CLAIM", body: { dispatch_id: "d1", call_id: "call-1" } }
    const first = await controller.commit(op, { holder_session_id: "A", expected_revision: rev, lease_fencing_token: lease.fencing_token })
    assert.equal(first.status, "committed")

    const replay = await controller.commit(op, { holder_session_id: "A", expected_revision: first.revision, lease_fencing_token: lease.fencing_token })
    assert.equal(replay.status, "replayed")

    // restart + reproject: the claim survives
    const restarted = await createExecutionController({ dir: controllerDir(root), lease_ttl_ms: 30000 })
    const snap = await restarted.snapshot()
    assert.equal(snap.state.dispatches.d1.launch_call_id, "call-1")

    // a different call id for the already-claimed dispatch is rejected
    const lease2 = await restarted.acquire("A")
    await assert.rejects(
      restarted.commit(
        { operation_id: "E1:claim:d1:call-2", operation_type: "DISPATCH_LAUNCH_CLAIM", body: { dispatch_id: "d1", call_id: "call-2" } },
        { holder_session_id: "A", expected_revision: first.revision, lease_fencing_token: lease2.fencing_token },
      ),
      /already claimed/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("claimDispatchLaunch writes a durable claim against the controller/<id> directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-claim-helper-"))
  try {
    const controller = await createExecutionController({ dir: controllerDir(root), lease_ttl_ms: 30000 })
    const lease = await controller.acquire("A")
    await commitSteps(controller, "A", lease.fencing_token, STEPS.slice(0, 3))

    const res = await claimDispatchLaunch(root, { execution_id: "E1", dispatch_id: "d1", call_id: "call-1", session_id: "A" })
    assert.equal(res.status, "committed")

    const snap = await controller.snapshot()
    assert.equal(snap.state.dispatches.d1.launch_call_id, "call-1")

    // replay (same execution_id + dispatch_id + call_id) is idempotent
    const replay = await claimDispatchLaunch(root, { execution_id: "E1", dispatch_id: "d1", call_id: "call-1", session_id: "A" })
    assert.equal(replay.status, "replayed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
