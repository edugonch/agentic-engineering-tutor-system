import test from "node:test"
import assert from "node:assert/strict"
import { inspectRepairBundle, classifyRepairCause } from "../../src/execution/repair-plan.js"

test("replay: independent reviewer produces one consolidated E05-06-E repair bundle", () => {
  const findings = [
    {id:"one",severity:"high",path:"tests/time.test.js",description:"Use resolveLocalWallClock for recurring local times"},
    {id:"two",severity:"high",path:"src/calendar.js",description:"Unknown exception kinds are silently ignored"},
    {id:"three",severity:"medium",path:"src/buffers.js",description:"Buffer defaults to zero unexpectedly"},
    {id:"four",severity:"high",path:".npmrc",description:"npm error EACCES /Users caused by host cache setting"}
  ]
  const state={ candidates:{c:{wu_id:"E05-06-E",tree_hash:"tree"}},
    dispatches:{d:{status:"result_reconciled",expected_agent:"harness-reviewer",
      session_id:"reviewer",prepared_by_session_id:"root",wu_id:"E05-06-E",
      handoff:{content_hash:"handoff",content:"review_findings: "+JSON.stringify({
        candidate_id:"c",tree_hash:"tree",findings})}}}}
  const result=inspectRepairBundle(state,"d","c")
  assert.equal(result.findings.length,4)
  assert.equal(result.findings[3].category,"RUNNER_SETUP")
  assert.equal(result.wu_id,"E05-06-E")
  assert.throws(()=>inspectRepairBundle(state,"d","unknown"),/REVIEW_REQUIRED/)
  assert.throws(()=>inspectRepairBundle({...state,dispatches:{d:{...state.dispatches.d,expected_agent:"harness-builder"}}},"d","c"),/REVIEW_REQUIRED/)
})
test("cause classifier is diagnostic only, never grants authority",()=>{
  assert.equal(classifyRepairCause("npm error ENOTFOUND"),"NETWORK")
  assert.equal(classifyRepairCause("execution_contract requires active_seconds"),"CONTRACT_SCHEMA")
  assert.equal(classifyRepairCause("BLOCKED_AUTHORITY requires owner approval"),"AUTHORITY")
  assert.equal(classifyRepairCause("invalid business code"),"PRODUCT_DEFECT")
})
