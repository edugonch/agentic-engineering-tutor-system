# Harness v1 — operator guide

Frozen baseline: `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848`.
Scope: install, update, start a project, approve an Epic, run the supported
autonomous path, and know exactly when control returns to the owner.

## 1. Install (from Git, frozen revision)

```sh
opencode plugin add 'github:edugonch/agentic-engineering-tutor-system#dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848'
```

- The plugin provisions/updates its global specialist profiles on load.
- Restart or reload the OpenCode server after install/update so the revision is
  actually loaded. A configured revision is not loading proof.
- Confirm:

```sh
opencode plugin list
```

Expected source:

```text
git+https://github.com/edugonch/agentic-engineering-tutor-system.git#dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848
```

## 2. Update

Re-point the plugin to the new pinned revision and reload:

```sh
opencode plugin remove opencode.agentic-harness
opencode plugin add 'github:edugonch/agentic-engineering-tutor-system#<new-sha>'
```

Then restart OpenCode. Managed profiles are refreshed only when unchanged;
customized profiles are preserved. Do not move off the frozen baseline without an
explicit owner decision and a new release report.

## 3. Verify readiness before any governed work

Call `harness_check_agent_readiness` (the orchestrator does this automatically
before activation and immediately before delegation). Required roles:
`harness-builder` and `harness-reviewer`, both loaded as subagents. If either is
missing/unknown, keep the WU unactivated and report the provisioning error.

## 4. Start a project

1. Start OpenCode in the target project.
2. Run `/harness` (or call `harness_initialize_project`) to initialize
   governance. Use `initialization_scope: full` for the complete scaffold or
   `governance_only` when only governance files are wanted.
3. For an existing codebase, run `harness_analyze_existing_project`, review the
   inventory, then `harness_import_project_knowledge` + `harness_initialize_project`
   with `project_type: existing`.
4. Configure models in `.harness/OPENCODE-CONFIG-FRAGMENT.jsonc` and merge into
   the root OpenCode config. Start a new session after changing models.
5. Check readiness (section 3).

## 5. Approve an Epic

1. Author a finite Epic with a terminal acceptance condition and a machine-
   readable mandate line, e.g.:

   ```text
   execution_mandate: {"max_wus": 1, "total_seconds": 900}
   ```

   The baseline supports budgets and `max_wus`; it does **not** support a
   `repair_policy` in v1 (see section 7).

2. The owner explicitly approves the Epic. Record it as an approved governance
   artifact with `harness_record_knowledge_artifact` (`declared_authority:
   APPROVED`). Note its `source_id` / `record_key`.
3. Approve the execution mandate:

   ```text
   harness_execution_controller {
     action: "approve_mandate",
     execution_id: "<new id>",
     mandate_id, mandate_revision,
     epic_artifact_id: "<record key>",
     max_wus, total_seconds
   }
   ```

4. Activate the derived WU with `action: "activate_wu"`. One active WU at a time;
   the WU cannot create child/successor WUs.

## 6. Normal autonomous execution

The orchestrator runs the supported v1 path:

```text
approve_mandate → activate_wu → reserve/prepare_launch/record_launch (build)
  → harness-builder implements the WU
  → record_finish/reconcile
  → harness_freeze_candidate (immutable candidate)
  → harness_run_verification (declared checks; durable receipts)
  → reserve/launch a FRESH independent harness-reviewer
  → record_review (candidate-bound; PASS needs full check coverage)
  → complete_wu
```

Domain notes:

- All external work has a positive finite reservation before its side effect.
- A restart replays durable records; use `status`/`recover` to resume safely.
- Unknown launch outcomes are marked ambiguous and are never assumed
  never-launched.
- An `AMBIGUOUS` dispatch is never auto-relaunched or auto-released. If
  owner/external investigation later establishes the exact already-launched
  session identity, `resolve_ambiguous_launch` may bind that identity with
  explicit recovery evidence while preserving the reservation and budget.

## 7. What happens on `CHANGES_REQUIRED` or `BLOCKED`

**Harness v1 stops. Control returns to the owner.** There is no autonomous repair
or blocker-recovery loop in v1. The one narrow exception is evidence-backed
launch-identity recovery: after owner/external investigation establishes the
exact session for an already-launched `AMBIGUOUS` dispatch, the controller may
record that fact through `resolve_ambiguous_launch`; it does not relaunch work,
change scope, or authorize a repair cycle.

- `CHANGES_REQUIRED`: the reviewer verdict and findings are recorded immutably.
  The orchestrator reports the WU, candidate, findings and budget, then stops.
  Do **not** call `authorize_repair`; do not issue a `repair_policy`.
- `BLOCKED_*` / `NO_PROGRESS` / `BUDGET_EXHAUSTED`: a governed stop is recorded.
  The orchestrator reports the typed stop and stops. Do **not** call
  `authorize_recovery`/`resolve_blocker`. (Those operations are Phase-4
  experimental and not part of v1.)
- Terminal blockers (`BLOCKED_PERMISSION`, `BLOCKED_AUTHORITY`,
  `BLOCKED_SECURITY`, `BLOCKED_SCOPE`) are sticky and are never downgraded.

### Owner intervention rule

Return control to the owner — and take no further autonomous action — whenever:

1. a reviewer returns anything other than PASS;
2. any blocker/terminal stop is recorded;
3. the budget is exhausted or a required next execution cannot be funded;
4. a launch outcome is ambiguous or unknown and exact external session identity has not yet been established;
5. scope, a verification contract, or a mandate would need to change;
6. a required check is missing;
7. readiness is missing/unknown;
8. anything falls outside the supported happy path.

The owner then decides: amend the Epic/contract, author a **new** WU/Epic under a
new owner-approved mandate, or abandon the work. v1 does not reset, retry,
recover, or repair a stranded/failed WU.

## 8. Stop conditions

Stop and report when: the WU completes, a stop is recorded, budget is exhausted,
a blocking decision is needed, or scope/contract would change. Never continue by
creating a successor/repair WU outside owner-approved authority.
