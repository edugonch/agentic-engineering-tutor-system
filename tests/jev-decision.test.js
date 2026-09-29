import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PRIMARY_CONTEXT_OPTIONS,
  validateDecisionSignal,
  createShadowPolicy,
  validateDecisionAudit,
  createDecisionProvider,
} from "../src/decision/contracts.js"
import { readJevSettings, createJevDecisionProvider, isJevReady } from "../src/decision/jev-provider.js"
import { buildAuditRecord, createAuditSink } from "../src/decision/audit.js"

const validSignal = {
  difficulty: 3,
  needsArchitecture: 0.2,
  needsDesign: 0.5,
  needsSecurity: 0.1,
  primaryContext: "design",
}

const validResponse = {
  model: "jev-1.13.0",
  answers: {
    difficulty: { type: "score", score: 2.6, legend: {}, probabilities: {}, confidence: 0.8 },
    needsArchitecture: { type: "noul", noul: 0.2 },
    needsDesign: { type: "noul", noul: 0.5 },
    needsSecurity: { type: "noul", noul: 0.1 },
    primaryContext: { type: "choice", choice: "design", probabilities: {}, confidence: 0.7 },
  },
  usage: { input_tokens: 100, output_tokens: 20 },
}

function makeFetch(response, options = {}) {
  let callCount = 0
  const calls = []
  const fetchImpl = async (url, init) => {
    callCount += 1
    calls.push({ url, init })
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      if (init?.signal?.aborted) {
        const error = new Error("The operation was aborted")
        error.name = "AbortError"
        throw error
      }
    }
    if (options.throwError) {
      throw options.throwError
    }
    return {
      ok: response.status < 400,
      status: response.status,
      json: async () => response.body,
    }
  }
  fetchImpl.calls = calls
  fetchImpl.callCount = () => callCount
  return fetchImpl
}

test("validates a correct DecisionSignal", () => {
  const result = validateDecisionSignal(validSignal)
  assert.equal(result.ok, true)
  assert.deepEqual(result.signal, validSignal)
})

test("rejects DecisionSignal with out-of-range difficulty", () => {
  for (const difficulty of [-1, 6, 2.5, null, undefined]) {
    const result = validateDecisionSignal({ ...validSignal, difficulty })
    assert.equal(result.ok, false)
    assert.match(result.error, /difficulty/)
  }
})

test("rejects DecisionSignal with invalid probabilities", () => {
  for (const key of ["needsArchitecture", "needsDesign", "needsSecurity"]) {
    for (const value of [-0.1, 1.1, "high", NaN]) {
      const result = validateDecisionSignal({ ...validSignal, [key]: value })
      assert.equal(result.ok, false)
      assert.match(result.error, new RegExp(key))
    }
  }
})

test("rejects DecisionSignal with invalid primaryContext", () => {
  const result = validateDecisionSignal({ ...validSignal, primaryContext: "magic" })
  assert.equal(result.ok, false)
  assert.match(result.error, /primaryContext/)
})

test("rejects DecisionSignal with unexpected fields", () => {
  const result = validateDecisionSignal({ ...validSignal, extra: true })
  assert.equal(result.ok, false)
  assert.match(result.error, /unexpected/)
})

test("shadow policy never returns an operational action", () => {
  const policy = createShadowPolicy()
  const decision = policy.apply(validSignal)
  assert.equal(decision.action, "none")
  assert.match(decision.reason, /shadow-mode/)
})

test("shadow policy validates signals", () => {
  const policy = createShadowPolicy()
  assert.throws(() => policy.apply({ ...validSignal, difficulty: 99 }), /difficulty/)
})

test("reads Jev settings with safe defaults", () => {
  const settings = readJevSettings({})
  assert.equal(settings.enabled, false)
  assert.equal(settings.apiKey, "")
  assert.equal(settings.model, "jev-1.13-free")
  assert.equal(settings.endpoint, "https://opencode.ai/zen/v1/systemone")
  assert.equal(settings.timeoutMs, 5000)
  assert.equal(settings.maxRetries, 1)
  assert.equal(settings.auditEnabled, false)
})

test("caps retries at one", () => {
  const settings = readJevSettings({ HARNESS_JEV_MAX_RETRIES: "5" })
  assert.equal(settings.maxRetries, 1)
})

test("isJevReady is false unless enabled and keyed", () => {
  assert.equal(isJevReady(readJevSettings({})), false)
  assert.equal(isJevReady(readJevSettings({ HARNESS_JEV_ENABLED: "1" })), false)
  assert.equal(
    isJevReady(readJevSettings({ HARNESS_JEV_API_KEY: "key" })),
    false,
  )
  assert.equal(
    isJevReady(readJevSettings({ HARNESS_JEV_ENABLED: "1", HARNESS_JEV_API_KEY: "key" })),
    true,
  )
})

test("provider parses a valid Jev response", async () => {
  const fetchImpl = makeFetch({ status: 200, body: validResponse })
  const provider = createJevDecisionProvider(
    { ...readJevSettings({}), apiKey: "test-key" },
    { fetch: fetchImpl },
  )
  const result = await provider.estimate({ taskId: "t1", state: "Refactor the auth module." })

  assert.equal(result.ok, true)
  assert.equal(result.signals.difficulty, 3)
  assert.equal(result.signals.needsArchitecture, 0.2)
  assert.equal(result.signals.needsDesign, 0.5)
  assert.equal(result.signals.needsSecurity, 0.1)
  assert.equal(result.signals.primaryContext, "design")
  assert.ok(result.latencyMs >= 0)

  const request = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(request.model, "jev-1.13-free")
  assert.equal(request.state, "Refactor the auth module.")
  assert.equal(request.questions.difficulty.type, "score")
  assert.equal(request.questions.needsSecurity.type, "noul")
  assert.equal(request.questions.primaryContext.type, "choice")
  assert.equal(fetchImpl.callCount(), 1)
})

test("provider truncates long state", async () => {
  const fetchImpl = makeFetch({ status: 200, body: validResponse })
  const provider = createJevDecisionProvider(
    { ...readJevSettings({}), apiKey: "test-key" },
    { fetch: fetchImpl },
  )
  const longState = "x".repeat(5000)
  await provider.estimate({ taskId: "t1", state: longState })
  const request = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(request.state.length, 2000)
})

test("provider rejects an unexpected top-level response field", async () => {
  const fetchImpl = makeFetch({
    status: 200,
    body: { ...validResponse, extraField: true },
  })
  const provider = createJevDecisionProvider(
    { ...readJevSettings({}), apiKey: "test-key" },
    { fetch: fetchImpl },
  )
  const result = await provider.estimate({ taskId: "t1", state: "x" })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /unexpected top-level/)
})

test("provider rejects an invalid score answer", async () => {
  const body = structuredClone(validResponse)
  body.answers.difficulty.score = 7
  const fetchImpl = makeFetch({ status: 200, body })
  const provider = createJevDecisionProvider(
    { ...readJevSettings({}), apiKey: "test-key" },
    { fetch: fetchImpl },
  )
  const result = await provider.estimate({ taskId: "t1", state: "x" })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /difficulty/)
})

test("provider rejects an invalid choice answer", async () => {
  const body = structuredClone(validResponse)
  body.answers.primaryContext.choice = "magic"
  const fetchImpl = makeFetch({ status: 200, body })
  const provider = createJevDecisionProvider(
    { ...readJevSettings({}), apiKey: "test-key" },
    { fetch: fetchImpl },
  )
  const result = await provider.estimate({ taskId: "t1", state: "x" })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /primaryContext/)
})

test("provider returns error on HTTP failure without retrying 4xx", async () => {
  const fetchImpl = makeFetch({ status: 401, body: {} })
  const provider = createJevDecisionProvider(
    { ...readJevSettings({}), apiKey: "test-key" },
    { fetch: fetchImpl },
  )
  const result = await provider.estimate({ taskId: "t1", state: "x" })
  assert.equal(result.ok, false)
  assert.equal(result.error.status, 401)
  assert.equal(fetchImpl.callCount(), 1)
})

test("provider retries once on 529 and then fails", async () => {
  const fetchImpl = makeFetch({ status: 529, body: {} })
  const provider = createJevDecisionProvider(
    { ...readJevSettings({}), apiKey: "test-key" },
    { fetch: fetchImpl },
  )
  const result = await provider.estimate({ taskId: "t1", state: "x" })
  assert.equal(result.ok, false)
  assert.equal(result.error.status, 529)
  assert.equal(fetchImpl.callCount(), 2)
})

test("provider respects maxRetries=0", async () => {
  const fetchImpl = makeFetch({ status: 529, body: {} })
  const provider = createJevDecisionProvider(
    { ...readJevSettings({ HARNESS_JEV_MAX_RETRIES: "0" }), apiKey: "test-key" },
    { fetch: fetchImpl },
  )
  const result = await provider.estimate({ taskId: "t1", state: "x" })
  assert.equal(result.ok, false)
  assert.equal(fetchImpl.callCount(), 1)
})

test("provider times out and retries once", async () => {
  const fetchImpl = makeFetch(
    { status: 200, body: validResponse },
    { delayMs: 100 },
  )
  const provider = createJevDecisionProvider(
    { ...readJevSettings({ HARNESS_JEV_TIMEOUT_MS: "20" }), apiKey: "test-key" },
    { fetch: fetchImpl },
  )
  const result = await provider.estimate({ taskId: "t1", state: "x" })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /timed out/)
  assert.equal(fetchImpl.callCount(), 2)
})

test("provider handles malformed JSON", async () => {
  let fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("not json")
    },
  })
  const provider = createJevDecisionProvider(
    { ...readJevSettings({}), apiKey: "test-key" },
    { fetch: fetchImpl },
  )
  const result = await provider.estimate({ taskId: "t1", state: "x" })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /not valid JSON/)
})

test("DecisionProvider contract rejects invalid providers", () => {
  assert.throws(() => createDecisionProvider({}), /estimate/)
  assert.throws(() => createDecisionProvider(null), /object/)
})

test("audit record contains no prompts, secrets, or code", () => {
  const record = buildAuditRecord({
    taskId: "task-123",
    model: "jev-1.13-free",
    signals: validSignal,
    latencyMs: 120,
    status: "ok",
  })
  assert.equal(record.schemaVersion, "jev-shadow-audit-v1")
  assert.equal(record.taskId, "task-123")
  assert.equal(record.model, "jev-1.13-free")
  assert.equal(record.latencyMs, 120)
  assert.equal(record.status, "ok")
  assert.deepEqual(record.signals, validSignal)
  assert.equal("prompt" in record, false)
  assert.equal("state" in record, false)
  assert.equal("apiKey" in record, false)
})

test("audit sanitizes errors that may contain secrets", () => {
  const error = new Error("Request failed with Bearer super-secret-token and api_key=another-secret")
  const record = buildAuditRecord({
    taskId: "task-123",
    model: "jev-1.13-free",
    latencyMs: 120,
    status: "error",
    error,
  })
  assert.match(record.error, /\[redacted\]/)
  assert.equal(record.error.includes("super-secret-token"), false)
  assert.equal(record.error.includes("another-secret"), false)
})

test("audit sink writes NDJSON when enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-jev-audit-"))
  try {
    const sink = createAuditSink(
      { auditEnabled: true, auditPath: "jev-audit.ndjson" },
      root,
    )
    const record = buildAuditRecord({
      taskId: "task-123",
      model: "jev-1.13-free",
      signals: validSignal,
      latencyMs: 120,
      status: "ok",
    })
    await sink.write(record)
    const lines = (await readFile(join(root, "jev-audit.ndjson"), "utf8"))
      .trim()
      .split("\n")
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0])
    assert.equal(parsed.taskId, "task-123")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("audit sink disables writing when path escapes the project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-jev-audit-escape-"))
  try {
    const sink = createAuditSink(
      { auditEnabled: true, auditPath: "../escape.ndjson" },
      root,
    )
    const record = buildAuditRecord({
      taskId: "task-123",
      model: "jev-1.13-free",
      signals: validSignal,
      latencyMs: 120,
      status: "ok",
    })
    await sink.write(record)
    await assert.rejects(
      readFile(join(root, "..", "escape.ndjson"), "utf8"),
      /ENOENT/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("disabled audit sink validates but does not write", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-jev-audit-disabled-"))
  try {
    const sink = createAuditSink({ auditEnabled: false }, root)
    const record = buildAuditRecord({
      taskId: "task-123",
      model: "jev-1.13-free",
      signals: validSignal,
      latencyMs: 120,
      status: "ok",
    })
    await sink.write(record)
    await assert.rejects(
      readFile(join(root, ".harness", "audit", "jev-decisions.ndjson"), "utf8"),
      /ENOENT/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
