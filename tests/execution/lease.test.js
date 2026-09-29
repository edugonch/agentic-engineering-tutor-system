import test from "node:test"
import assert from "node:assert/strict"
import { isLeaseExpired, nextLease } from "../../src/execution/lease.js"

test("a new lease starts the fencing generation at 1", () => {
  const lease = nextLease(null, { holder_session_id: "A", now: () => 0 })
  assert.equal(lease.fencing_token, 1)
  assert.equal(lease.holder_session_id, "A")
})

test("same-holder renewal keeps the fencing token and lease id", () => {
  const first = nextLease(null, { holder_session_id: "A", now: () => 0, ttl_ms: 1000 })
  const renewed = nextLease(first, { holder_session_id: "A", now: () => 500, ttl_ms: 1000 })
  assert.equal(renewed.fencing_token, first.fencing_token)
  assert.equal(renewed.lease_id, first.lease_id)
})

test("an expired lease transfers ownership and increments the generation", () => {
  const first = nextLease(null, { holder_session_id: "A", now: () => 0, ttl_ms: 1000 })
  assert.equal(isLeaseExpired(first, () => 2000), true)
  const second = nextLease(first, { holder_session_id: "B", now: () => 2000, ttl_ms: 1000 })
  assert.equal(second.fencing_token, 2)
  assert.equal(second.holder_session_id, "B")
})

test("a held lease refuses a different holder", () => {
  const first = nextLease(null, { holder_session_id: "A", now: () => 0, ttl_ms: 1000 })
  assert.throws(() => nextLease(first, { holder_session_id: "B", now: () => 500, ttl_ms: 1000 }), /held by session A/)
})

test("fencing token is an integer generation, not derived from time", () => {
  const a = nextLease(null, { holder_session_id: "A", now: () => 1000000, ttl_ms: 1 })
  const b = nextLease(a, { holder_session_id: "B", now: () => 999999999, ttl_ms: 1 })
  assert.equal(a.fencing_token, 1)
  assert.equal(b.fencing_token, 2) // monotonic, independent of clock magnitude
})
