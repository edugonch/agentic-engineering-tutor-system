import test from "node:test"
import assert from "node:assert/strict"
import { createLaunchBindingRegistry } from "../../src/execution/launch-binding.js"

test("binding is consumed exactly once (single-use)", () => {
  const r = createLaunchBindingRegistry()
  r.set("A", "harness-reviewer", { execution_id: "E1", dispatch_id: "d1" })
  assert.deepEqual(r.consume("A", "harness-reviewer"), { execution_id: "E1", dispatch_id: "d1" })
  assert.equal(r.consume("A", "harness-reviewer"), undefined) // second consume leaves nothing
  assert.equal(r.size(), 0)
})

test("second prepare for the same session+agent is rejected, not overwritten", () => {
  const r = createLaunchBindingRegistry()
  r.set("A", "harness-reviewer", { execution_id: "E1", dispatch_id: "d1" })
  assert.throws(
    () => r.set("A", "harness-reviewer", { execution_id: "E1", dispatch_id: "d2" }),
    /already pending/,
  )
  // the original binding is intact (never silently overwritten)
  assert.deepEqual(r.peek("A", "harness-reviewer"), { execution_id: "E1", dispatch_id: "d1" })
})

test("bindings are isolated per session and per agent", () => {
  const r = createLaunchBindingRegistry()
  r.set("A", "harness-reviewer", { execution_id: "E1", dispatch_id: "d1" })
  r.set("B", "harness-reviewer", { execution_id: "E2", dispatch_id: "d2" })
  r.set("A", "harness-builder", { execution_id: "E3", dispatch_id: "d3" })
  assert.deepEqual(r.consume("A", "harness-reviewer"), { execution_id: "E1", dispatch_id: "d1" })
  assert.deepEqual(r.peek("B", "harness-reviewer"), { execution_id: "E2", dispatch_id: "d2" })
  assert.deepEqual(r.peek("A", "harness-builder"), { execution_id: "E3", dispatch_id: "d3" })
})

test("consume on a missing key returns undefined and leaves the registry clean", () => {
  const r = createLaunchBindingRegistry()
  assert.equal(r.consume("A", "nobody"), undefined)
  assert.equal(r.size(), 0)
})

test("a consumed binding cannot be re-claimed by a later call to the same agent", () => {
  const r = createLaunchBindingRegistry()
  r.set("A", "harness-reviewer", { execution_id: "E1", dispatch_id: "d1" })
  assert.deepEqual(r.consume("A", "harness-reviewer"), { execution_id: "E1", dispatch_id: "d1" })
  // a later call for the same agent finds no binding (no stale re-claim)
  assert.equal(r.peek("A", "harness-reviewer"), undefined)
  assert.equal(r.consume("A", "harness-reviewer"), undefined)
})
