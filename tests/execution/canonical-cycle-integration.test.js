// This integration test exercises the real durable controller and its read-only
// orchestration projection. Worker, reviewer and merge evidence are synthetic:
// it is NOT an OpenCode provider canary or an independent reviewer attestation.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionController } from "../../src/execution/execution.js";
import { runExecutionController } from "../../src/execution/controller-tool.js";

test("canonical same-WU correction survives replay, then advances within approved sequence", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-canonical-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, ".harness", "execution", "controller", "E1");
  const c = await createExecutionController({ dir });
  const commit = async (type, body) => {
    const lease = await c.acquire("root");
    const { state } = await c.snapshot();
    return c.commit({
      operation_id: "scenario:" + state.revision, operation_type: type, body,
    }, {
      holder_session_id: "root", expected_revision: state.revision,
      lease_fencing_token: lease.fencing_token,
    });
  };
  const view = () => runExecutionController(root, { action: "operational_status", execution_id: "E1" });
  await commit("MANDATE_APPROVE", {
    execution_id: "E1", mandate_id: "M1", total_seconds: 100, max_wus: 2,
    authority_kind: "OWNER_APPROVED_EPIC", wu_sequence: ["WU1", "WU2"], merge_policy: "none",
  });
  await commit("WU_ACTIVATE", { wu_id: "WU1", mandate_id: "M1" });
  assert.equal((await view()).next_action, "LAUNCH_ONE_BUILDER");

  const build = async (id) => {
    await commit("DISPATCH_RESERVE", { dispatch_id: id, reserved_seconds: 10 });
    await commit("DISPATCH_PREPARE", { dispatch_id: id, expected_agent: "harness-builder",
      prepared_by_session_id: "root", claim_required: false });
    await commit("DISPATCH_LAUNCH", { dispatch_id: id, session_id: id + "-child" });
    assert.equal((await view()).next_action, "AWAIT_EXISTING_BUILDER");
    await commit("DISPATCH_FINISH", { dispatch_id: id, result: "worker completed" });
    assert.equal((await view()).next_action, "RECONCILE_FINISHED_DISPATCH");
    await commit("DISPATCH_RECONCILE", { dispatch_id: id });
  };
  const candidate = async id => commit("FREEZE_CANDIDATE", {
    candidate_id: id, wu_id: "WU1", manifest_hash: "m-" + id, tree_hash: "t-" + id,
    required_check_ids: [], verification_contract_hash: null,
  });
  const review = async (id, verdict) => commit("RECORD_REVIEW", {
    candidate_id: id, candidate_hashes: { manifest_hash: "m-" + id, tree_hash: "t-" + id },
    verdict, verification_evidence_ids: ["receipt-" + id], verified_check_ids: [],
    verification_contract_hash: null,
  });

  await build("build1");
  assert.equal((await view()).next_action, "INSPECT_BUILDER_RESULT_BEFORE_RELAUNCH");
  await candidate("c1");
  assert.equal((await view()).phase, "VERIFYING");
  await review("c1", "CHANGES_REQUIRED");
  assert.equal((await view()).next_action, "REPAIR_SAME_WU");
  await build("repair1");
  assert.equal((await view()).next_action, "INSPECT_REPAIR_RESULT_BEFORE_RELAUNCH");
  await candidate("c2");
  assert.equal((await view()).phase, "VERIFYING");
  await review("c2", "PASS");
  assert.equal((await view()).next_action, "COMPLETE_WU");
  await commit("WU_COMPLETE", { candidate_id: "c2" });
  let output = await view();
  assert.equal(output.phase, "READY");
  assert.equal(output.next_wu_id, "WU2");
  assert.equal(output.next_action, "ACTIVATE_NEXT_APPROVED_WU");
  const before = (await c.snapshot()).state.revision;
  assert.equal((await view()).revision, before);
  assert.equal((await c.snapshot()).state.revision, before);
  await commit("WU_ACTIVATE", { wu_id: "WU2", mandate_id: "M1" });
  output = await view();
  assert.equal(output.wu_id, "WU2");
  assert.equal(output.next_action, "LAUNCH_ONE_BUILDER");
  assert.equal((await runExecutionController(root, { action: "verify", execution_id: "E1" })).passed, true);
});
