# Phase 1 — Independent, reproducible verification

## Objective

Make "independent review" mean actually re-verifying an immutable, reproducible
candidate, without letting the reviewer mutate the environment it is reviewing.

## Exit condition

Phase 1 passes only when the following chain is demonstrable, in runtime:

```text
Authorized working tree
        ↓
FREEZE
        ↓
candidate_id + manifest_hash + tree_hash
        ↓
reproducible materialization
        ↓
isolated verification workspace
        ↓
reviewer inspects the exact candidate, runs declared checks, does not edit the
checkout, and produces a review bound to candidate_id
        ↓
PASS / CHANGES_REQUIRED / BLOCKED
```

And it must be demonstrated that `PASS(candidate A) ≠ PASS(candidate B)` even
when B differs from A by a single byte.

## P1 — Candidate freeze (reproducible)

`manifest_hash` and `tree_hash` already exist as pure hash functions; this phase
turns them into a real reproducible candidate. The manifest captures:

- base repository identity + base commit;
- authorized paths;
- modified tracked files;
- authorized new files;
- deletions;
- mode bits;
- symlinks recorded as symlinks (never followed);
- recoverable content hash per entry;
- candidate manifest hash;
- materialized tree hash;
- timestamp as metadata only (not part of identity).

Freeze must detect races: `scan → capture → verify working paths unchanged →
publish`. A change during freeze yields `CANDIDATE_CHANGED_DURING_FREEZE` and no
valid candidate.

## P2 — Verification workspace

Materialization: `candidate_id → temporary workspace → reconstruct exact
candidate → verify tree_hash`. Tests run against the reconstruction, never the
working tree. Initial properties:

```text
repo checkout protected   ✅
workspace disposable      ✅
restricted cwd            ✅
temporary/sanitized HOME  ✅
environment allowlist     ✅
process ownership tracking✅
network isolation         explicit (false initially)
OS sandbox                explicit false initially
```

It is not called a sandbox while it is not one.

## P3 — Verification contract of the WU

A typed declaration, e.g.:

```text
verification:
  commands:
    - node --test tests/wu-01.test.cjs
  capabilities:
    - shell.node
  environment:
    network: false
```

The reviewer must not improvise arbitrary shell because "it is a reviewer". It
may (1) run declared checks, (2) run read-only diagnostics needed to interpret a
failure, and (3) request `BLOCKED_CAPABILITY` when it needs an undeclared
capability. Capability expansion returns to the controller, not the model.

## P4 — Executable reviewer (only after the substrate exists)

Change `harness-reviewer` only now. Conceptually:

```text
DENY:  Write, Edit, Patch, ApplyPatch, repository mutation, subagent
ALLOW: Read, declared verification execution, safe status/diff inspection,
       browser read/interaction when declared
```

Do not give raw `bash`. Instead the plugin exposes `harness_run_verification`,
which receives `candidate_id` + `verification_check_id` and is responsible for
materializing the workspace, validating the command is declared, executing,
capturing exit code/stdout/stderr, recording a runtime fingerprint, killing only
its own processes, and returning evidence. The reviewer gets independent
execution without becoming a shell agent.

## P5 — Capability preflight

Extend `harness_check_execution_readiness` to evaluate the concrete WU:

```text
required capabilities → builder, reviewer, verification runner, tool binaries,
browser/runtime, workspace support, budget reserve
```

Structured result: `READY`, or `BLOCKED_CAPABILITY` with the missing capability
and reason. Do not start BUILD when preflight already knows REVIEW is impossible.

## P6 — Mandatory fault-injection tests

1. Candidate A → review PASS → change 1 byte → candidate B → PASS(A) rejected for B.
2. File changes during freeze → freeze fails.
3. Symlink escaping the repo → candidate fails closed.
4. Reviewer runs a test that writes files → only the verification workspace changes.
5. Test spawns child processes → cleanup kills only workspace processes.
6. Undeclared command → deny.
7. Required binary disappears after preflight → review returns `BLOCKED_CAPABILITY`, not PASS.
8. Working tree changes after freeze → review of A continues over A, uncontaminated.
9. Reconstructed workspace tree hash differs → hard fail.
10. Reviewer attempts Write/Edit/Patch → permission rejection with no alternative.

## Order

1. PHASE-1-CONTRACT
2. Reproducible candidate freeze
3. Verification workspace
4. Verification command/capability contract
5. `harness_run_verification`
6. Reviewer consumes that tool
7. Per-WU execution readiness
8. Fault-injection tests
9. Runtime empirical verification
10. PHASE_1 PASS/FAIL

## Explicitly out of scope (for now)

JIT WU derivation, the Epic autonomous loop, general blocker resolution,
additional Phase 3 state transitions, merge/deploy, general builder permissions,
and multiple repair cycles. Phase 1 has one mission: make "independent review"
mean re-verifying an immutable, reproducible candidate without letting the
reviewer mutate what it reviews.
