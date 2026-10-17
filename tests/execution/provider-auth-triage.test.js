import test from "node:test"
import assert from "node:assert/strict"
import { inspectProviderAuthBlocker } from "../../src/execution/provider-auth-triage.js"

const state = () => ({
  blocker: { class: "BLOCKED_TOOLING", reason: "provider.auth: This API key has expired", at_revision: 548 },
  wu: { wu_id: "E05-04-E", completed: false },
  dispatches: {
    "e0504-repair-1": {
      wu_id: "E05-04-E", status: "result_reconciled", expected_agent: "harness-builder",
      session_id: "ses_actual", handoff: { content_hash: "sha256-immutable" },
    },
  },
})

test("legacy provider.auth is recognized but cannot clear by reading prose", () => {
  const r = inspectProviderAuthBlocker(state())
  assert.equal(r.status, "EVIDENCE_REQUIRED")
  assert.equal(r.blocker_kind, "LEGACY_AUTH_TEXT")
  assert.equal(r.can_clear, false)
  assert.equal(r.blocked_at_revision, 548)
  assert.equal(r.dispatches[0].terminal, true)
  assert.ok(r.missing.includes("live_provider_auth_canary"))
})

test("typed incident is only probe-eligible with exact terminal dispatch", () => {
  const s = state()
  s.blocker = { ...s.blocker, kind: "PROVIDER_AUTH", dispatch_id: "e0504-repair-1" }
  const result = inspectProviderAuthBlocker(s)
  assert.equal(result.status, "ELIGIBLE_FOR_PROBE")
  assert.equal(result.can_clear, false)
  s.dispatches["e0504-repair-1"].status = "ambiguous"
  assert.equal(inspectProviderAuthBlocker(s).status, "EVIDENCE_REQUIRED")
})

test("not-auth and authority blockers cannot be treated as recovery opportunities", () => {
  const s = state()
  s.blocker = { class: "BLOCKED_TOOLING", reason: "npm ci setup timed out", at_revision: 549 }
  assert.equal(inspectProviderAuthBlocker(s).status, "NOT_AUTH_RELATED")
  s.blocker = { class: "BLOCKED_AUTHORITY", reason: "provider.auth expired", at_revision: 550 }
  assert.equal(inspectProviderAuthBlocker(s).status, "NOT_AUTH_RELATED")
  s.blocker = null
  assert.equal(inspectProviderAuthBlocker(s).status, "NOT_AUTH_RELATED")
})
