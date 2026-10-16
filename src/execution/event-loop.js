// OpenCode event subscriptions are long-lived, but a provider/handler error
// can terminate a single async iterator. Never leave the execution supervisor
// permanently deaf after one transient failure. No user-facing actions are
// performed by this transport loop; the controller continues to enforce gates.
function waitForRetry(ms, signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve() }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    signal.addEventListener("abort", finish, { once: true })
  })
}

export async function runResilientEventLoop({ subscribe, onEvent, onError = () => {}, signal,
  retryDelayMs = 500, maxDelayMs = 5000, sleep = waitForRetry }) {
  if (!signal || typeof signal.aborted !== "boolean") throw new Error("Event loop requires an AbortSignal")
  if (typeof subscribe !== "function" || typeof onEvent !== "function") throw new Error("Event loop needs subscribe/onEvent")
  let delay = retryDelayMs
  while (!signal.aborted) {
    try {
      const stream = subscribe({ signal })
      for await (const event of stream) {
        if (signal.aborted) break
        try { await onEvent(event) }
        catch (error) {
          // A failed observation must not disable future events. The next
          // event rechecks the durable controller state independently.
          onError(error)
        }
        delay = retryDelayMs
      }
      if (!signal.aborted) onError(new Error("OpenCode event subscription ended; reconnecting"))
    } catch (error) {
      if (!signal.aborted) onError(error)
    }
    if (signal.aborted) break
    await sleep(delay, signal)
    delay = Math.min(maxDelayMs, Math.max(retryDelayMs, delay * 2))
  }
}
