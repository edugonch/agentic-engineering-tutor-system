import test from "node:test"
import assert from "node:assert/strict"
import { createHarnessBootstrapPrompt, registerHarnessCommand } from "../src/bootstrap-command.js"

test("bootstrap prompt preserves the owner's request and keeps intake approval-gated", () => {
  const prompt = createHarnessBootstrapPrompt("Build a workshop waitlist")
  assert.match(prompt, /Build a workshop waitlist/)
  assert.match(prompt, /Do not write files, initialize the Harness, implement code/)
  assert.match(prompt, /harness_analyze_existing_project/)
  assert.match(prompt, /harness_initialize_project/)
  assert.match(prompt, /If the Harness tools are unavailable, stop/)
})

test("bootstrap command forwards the session, delivery, and attachments into intake", async () => {
  let command
  const sent = []
  const ctx = {
    command: {
      transform: async (callback) => callback({ add: (definition) => { command = definition } }),
    },
    session: { prompt: async (input) => sent.push(input) },
  }

  await registerHarnessCommand(ctx)
  assert.equal(command.name, "harness")
  await command.execute({
    sessionID: "session-1",
    prompt: { text: "Start the waitlist project", parts: [{ type: "file", url: "file:///brief.md" }] },
    delivery: "steer",
  })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].sessionID, "session-1")
  assert.equal(sent[0].delivery, "steer")
  assert.deepEqual(sent[0].parts, [{ type: "file", url: "file:///brief.md" }])
  assert.match(sent[0].text, /Start the waitlist project/)
})
