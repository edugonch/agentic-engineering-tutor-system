import test from "node:test"
import assert from "node:assert/strict"
import { runResilientEventLoop } from "../../src/execution/event-loop.js"

test("event handler failure is isolated; subsequent terminal event still reaches supervisor", async () => {
  const abort = new AbortController()
  const seen = [], errors = []
  await runResilientEventLoop({
    signal: abort.signal,
    subscribe: async function* () {
      yield { id: "bad" }
      yield { id: "terminal" }
    },
    onEvent: async event => {
      if (event.id === "bad") throw new Error("single event handler failed")
      seen.push(event.id)
      abort.abort()
    },
    onError: error => errors.push(error.message),
    sleep: async () => { throw new Error("Unexpected reconnect") },
  })
  assert.deepEqual(seen, ["terminal"])
  assert.ok(errors.some(e => /handler failed/.test(e)))
})

test("lost event subscription reconnects, observes later event, and stops on abort", async () => {
  const abort = new AbortController()
  const errors = [], observed = [], delays = []
  let calls = 0
  await runResilientEventLoop({
    signal: abort.signal,
    subscribe: () => {
      calls++
      if (calls === 1) throw new Error("Transport lost")
      return (async function* () {
        yield { type: "session.execution.succeeded" }
      })()
    },
    onEvent: async event => { observed.push(event.type); abort.abort() },
    onError: error => errors.push(error.message),
    retryDelayMs: 50,
    sleep: async delay => { delays.push(delay) },
  })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [50])
  assert.deepEqual(observed, ["session.execution.succeeded"])
  assert.ok(errors.some(e => e.includes("Transport lost")))
})

test("normal end of subscription never spins: a bounded delay precedes reconnection", async () => {
  const abort = new AbortController()
  let attempts = 0, pauses = 0
  await runResilientEventLoop({
    signal: abort.signal,
    subscribe: () => {
      attempts++
      return (async function* () {})()
    },
    onEvent: async () => {},
    onError: () => {},
    sleep: async () => { pauses++; abort.abort() },
  })
  assert.equal(attempts, 1)
  assert.equal(pauses, 1)
})
