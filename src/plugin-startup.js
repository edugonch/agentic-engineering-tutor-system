// A plugin's setup() is a Location readiness boundary. Do not await recoverable
// agent registry reloads or historical execution scans in that boundary:
// OpenCode must be able to expose its provider/model catalog even if one of
// these follow-up tasks hangs or fails. This helper does not bypass execution
// admission, grant permissions, or mutate durable Harness state by itself.
export function deferPluginStartup({
  tasks = [],
  onError = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  let disposed = false
  const handle = schedule(() => {
    if (disposed) return
    for (const task of tasks) {
      Promise.resolve()
        .then(() => { if (!disposed) return task.run() })
        .catch(error => {
          if (disposed) return
          try { onError(task.name, error) } catch { /* diagnostics must not crash startup */ }
        })
    }
  }, 0)
  handle?.unref?.()
  return () => {
    disposed = true
    cancel(handle)
  }
}
