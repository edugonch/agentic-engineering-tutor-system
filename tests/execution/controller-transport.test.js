import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { extractControllerInvocation } from "../../src/execution/controller-transport.js"

const wrap = (obj) => `return await tools["harness_execution_controller"](${JSON.stringify(obj)})`
const wrapPretty = (obj) => `return await tools[
  "harness_execution_controller"
](
  ${JSON.stringify(obj)}
)`

test("direct controller event is extracted unchanged", () => {
  const input = { action: "status", execution_id: "E" }
  const result = extractControllerInvocation({ tool: "harness_execution_controller", input })
  assert.deepEqual(result, { tool: "harness_execution_controller", input })
})

test("direct controller event tolerates missing input", () => {
  const result = extractControllerInvocation({ tool: "harness_execution_controller" })
  assert.deepEqual(result, { tool: "harness_execution_controller", input: {} })
})

test("exact observed bracket-literal Code Mode wrapper is recognized", () => {
  const code = 'return await tools["harness_execution_controller"]({ action: "status", execution_id: "E" })'
  const result = extractControllerInvocation({ tool: "execute", input: { code } })
  assert.equal(result?.tool, "harness_execution_controller")
  assert.equal(result?.input?.action, "status")
  assert.equal(result?.input?.execution_id, "E")
})

test("pretty-printed wrapper with harmless whitespace is recognized", () => {
  const code = wrapPretty({ action: "status", execution_id: "E" })
  const result = extractControllerInvocation({ tool: "execute", input: { code } })
  assert.deepEqual(result?.input, { action: "status", execution_id: "E" })
})

test("inner object with nested literals is recovered correctly", () => {
  const input = {
    action: "record_finish",
    execution_id: "E",
    dispatch_id: "d1",
    result: "done",
    note: "with \"quotes\"",
    count: 42,
    enabled: true,
    missing: null,
    tags: ["a", "b", { nested: "value" }],
    meta: { revision: 1.5, ok: false },
  }
  const result = extractControllerInvocation({ tool: "execute", input: { code: wrap(input) } })
  assert.deepEqual(result?.input, input)
})

test("generic return 42 is NOT controller", () => {
  assert.equal(extractControllerInvocation({ tool: "execute", input: { code: "return 42" } }), null)
})

test("another tools[...] target is NOT controller", () => {
  const code = 'return await tools["read"]({ path: "payload.txt" })'
  assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null)
})

test("variable target is rejected", () => {
  const code = 'return await tools[name]({ action: "status", execution_id: "E" })'
  assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null)
})

test("concatenated/dynamic target is rejected", () => {
  const code = 'return await tools["harness_" + suffix]({ action: "status", execution_id: "E" })'
  assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null)
})

test("alias is rejected", () => {
  const code = 'const f = tools["harness_execution_controller"]; return await f({ action: "status", execution_id: "E" })'
  assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null)
})

test("controller name inside string is rejected", () => {
  const code = 'console.log("harness_execution_controller")'
  assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null)
})

test("controller name inside comment is rejected", () => {
  const code = '// tools["harness_execution_controller"]({ action: "status" })'
  assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null)
})

test("malformed wrapper is rejected", () => {
  const cases = [
    'return await tools["harness_execution_controller"]({ action: "status", })', // trailing comma
    'return await tools["harness_execution_controller"](action: "status")', // not an object
    'return await tools["harness_execution_controller"]()', // no argument
    'return await tools["harness_execution_controller"]({ action: status })', // unquoted identifier value
    'return await tools["harness_execution_controller"]({ action: foo() })', // function call
    'return await tools["harness_execution_controller"]({ action: "status" }, extra)', // extra arg
  ]
  for (const code of cases) {
    assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null, `expected rejection for: ${code}`)
  }
})

test("extra statement before call is rejected", () => {
  const code = 'const x = 1; return await tools["harness_execution_controller"]({ action: "status" })'
  assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null)
})

test("extra statement after call is rejected", () => {
  const code = 'return await tools["harness_execution_controller"]({ action: "status" }); console.log("done")'
  assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null)
})

test("multiple calls are rejected", () => {
  const code = 'return await tools["harness_execution_controller"]({ action: "status" }) + await tools["harness_execution_controller"]({ action: "status" })'
  assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null)
})

test("previously observed combined controller + generic program is rejected", () => {
  const code = `
    const result1 = await tools["harness_execution_controller"]({ action: "status", execution_id: "E" })
    const result2 = await (async () => 42)()
    return { result1, result2 }
  `
  assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null)
})

test("nested executable expression in controller input is rejected", () => {
  const cases = [
    'return await tools["harness_execution_controller"]({ action: "status", x: 1 + 2 })',
    'return await tools["harness_execution_controller"]({ action: "status", x: [...spread] })',
    'return await tools["harness_execution_controller"]({ action: "status", x: () => 42 })',
    'return await tools["harness_execution_controller"]({ get action() { return "status" } })',
  ]
  for (const code of cases) {
    assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null, `expected rejection for: ${code}`)
  }
})

test("single quotes in bracket literal are rejected", () => {
  const code = "return await tools['harness_execution_controller']({ action: 'status' })"
  assert.equal(extractControllerInvocation({ tool: "execute", input: { code } }), null)
})

test("observed dot notation is recognized", () => {
  const code = 'return await tools.harness_execution_controller({ action: "status" })'
  assert.deepEqual(extractControllerInvocation({ tool: "execute", input: { code } })?.input, { action: "status" })
})

test("exact observed specialist multi-line dot wrapper is recognized", () => {
  // Captured verbatim from a real harness-builder Code Mode mutation.
  const code = 'return await tools.harness_execution_controller({\n  action: "checkpoint",\n  execution_id: "P4-TRANSPORT-CANARY-005",\n  checkpoint_id: "specialist-mutation-canary"\n})'
  assert.deepEqual(extractControllerInvocation({ tool: "execute", input: { code } }), {
    tool: "harness_execution_controller",
    input: { action: "checkpoint", execution_id: "P4-TRANSPORT-CANARY-005", checkpoint_id: "specialist-mutation-canary" },
  })
})

test("rejects ambiguous JavaScript literals and prototype keys", () => {
  for (const input of ['{ count: 010 }', '{ action: "status", action: "checkpoint" }', '{ __proto__: { action: "status" } }', '{ action: "line\nbreak" }', '{ action: "\\01" }']) {
    assert.equal(extractControllerInvocation({ tool: "execute", input: { code: `return await tools["harness_execution_controller"](${input})` } }), null, input)
  }
})

test("malformed end-of-input fails closed without hanging", () => {
  const code = 'return await tools["harness_execution_controller"]({ action: true)'
  const script = `import { extractControllerInvocation } from ${JSON.stringify(new URL('../../src/execution/controller-transport.js', import.meta.url).href)}; console.log(JSON.stringify(extractControllerInvocation({ tool: 'execute', input: { code: ${JSON.stringify(code)} } })))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), 'null')
})

test("non-execute events are ignored", () => {
  assert.equal(extractControllerInvocation({ tool: "read", input: { path: "x" } }), null)
  assert.equal(extractControllerInvocation(null), null)
  assert.equal(extractControllerInvocation({ tool: "execute" }), null)
})
