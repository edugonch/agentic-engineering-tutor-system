// Execution lease with a monotonic fencing token.
//
// The fencing token is an integer generation, assigned while holding the
// execution mutex. It is NOT derived from wall-clock time, so a suspended
// controller that wakes up later cannot win a write against the controller that
// legitimately re-acquired the lease.

import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { atomicWriteDurable } from "./fsync.js"

export async function readLease(leasePath) {
  try {
    return JSON.parse(await readFile(leasePath, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

export function isLeaseExpired(lease, now) {
  if (!lease) return true
  return !Number.isFinite(lease.expires_at) || now() >= lease.expires_at
}

export async function writeLease(leasePath, lease) {
  await atomicWriteDurable(leasePath, JSON.stringify(lease, null, 2) + "\n")
}

// Compute the next lease state. A same-holder renewal keeps its token; any
// transfer of ownership (absent, expired, or a different holder) increments the
// fencing generation.
export function nextLease(current, { holder_session_id, now, ttl_ms = 60000 }) {
  const timestamp = now()
  const heldByOther = current && !isLeaseExpired(current, now) && current.holder_session_id !== holder_session_id
  if (heldByOther) {
    throw new Error(`Execution lease is held by session ${current.holder_session_id}; cannot acquire for ${holder_session_id}.`)
  }
  const isSameHolder = Boolean(current) && !isLeaseExpired(current, now) && current.holder_session_id === holder_session_id
  return {
    lease_id: isSameHolder ? current.lease_id : randomUUID(),
    fencing_token: isSameHolder ? current.fencing_token : (current?.fencing_token ?? 0) + 1,
    holder_session_id,
    acquired_at: isSameHolder ? current.acquired_at : timestamp,
    expires_at: timestamp + ttl_ms,
    state_revision: current?.state_revision ?? 0,
  }
}
