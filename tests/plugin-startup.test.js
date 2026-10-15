import test from "node:test"
import assert from "node:assert/strict"
import { deferPluginStartup } from "../src/plugin-startup.js"

test("deferred startup leaves Location activation independent of a hanging reload", async () => {
  const calls = []
  let trigger
  const errors = []
  const cancel = deferPluginStartup({
    tasks: [
      { name: "agent.reload", run: () => { calls.push("reload"); return new Promise(() => {}) } },
      { name: "supervisor.resume", run: () => { calls.push("supervisor"); return "done" } },
    ],
    onError: (name, error) => errors.push({ name, message: error.message }),
    schedule: callback => { trigger = callback; return { unref() {} } },
    cancel: () => {},
  })
  assert.deepEqual(calls, [], "setup returns before either recoverable startup task begins")
  trigger()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ["reload", "supervisor"], "a hung reload never blocks independent supervisor recovery")
  assert.deepEqual(errors, [])
  cancel()
})

test("deferred startup records nonfatal errors and cancels unused tasks", async () => {
  let trigger
  const errors = []
  const cancel = deferPluginStartup({
    tasks: [{ name: "supervisor.resume", run: () => { throw new Error("legacy replay failed") } }],
    onError: (name, error) => errors.push({ name, message: error.message }),
    schedule: callback => { trigger = callback; return 1 },
    cancel: () => {},
  })
  trigger()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(errors, [{ name: "supervisor.resume", message: "legacy replay failed" }])
  cancel()

  let ran = false
  let cancelled = false
  const dispose = deferPluginStartup({
    tasks: [{ name: "never", run: () => { ran = true } }],
    schedule: callback => { trigger = callback; return 2 },
    cancel: () => { cancelled = true },
  })
  dispose()
  trigger()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
  assert.equal(ran, false)
})
