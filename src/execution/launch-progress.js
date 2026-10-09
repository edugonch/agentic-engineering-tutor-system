// Observe supported tool progress before the child starts its own tool loop.
// The original tool and its UI progress remain unchanged.
export function observeSubagentProgress(editor, recovery) {
  editor.update("subagent", tool => {
    const execute = tool.execute
    tool.execute = async (input, context) => execute(input, {
      ...context,
      progress: async metadata => {
        await context.progress(metadata)
        if (metadata?.sessionID) {
          const result = await recovery.onProgress({ tool: "subagent", sessionID: context.sessionID,
            id: context.id, messageID: context.messageID, input, metadata })
          if (result && result.status !== "IDENTITY_CONFIRMED") throw new Error(`HARNESS_LAUNCH_IDENTITY: ${result.reason ?? result.status}`)
        }
      },
    })
  })
}
