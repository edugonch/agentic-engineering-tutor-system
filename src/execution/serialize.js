// Deterministic serialization + hashing for the execution core.
//
// Everything that is hashed for identity (operation hashes, candidate manifest
// and tree hashes) goes through stableSerialize so that key order and formatting
// never affect the digest. This keeps idempotency detection and candidate
// binding deterministic.

import { createHash } from "node:crypto"

export function stableSerialize(value) {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex")
}

export function stableHash(value) {
  return sha256(stableSerialize(value))
}
