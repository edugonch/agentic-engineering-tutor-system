# Harness v1 — capability matrix

Frozen baseline: `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848` (accepted Phase 3 SHA).
This matrix describes what the frozen baseline supports, what is explicitly
unsupported/experimental, and the known limitations. It is derived from the
baseline operation surface (`src/execution/constants.js`,
`src/execution/controller-tool.js`, `index.js`) and from the accepted Phase 0–3
runtime evidence, not from Phase-4 documentation.

## 1. Supported (released in v1)

### 1.1 Tooling and governance

| Capability | Status | Evidence / surface |
|---|---|---|
| Install/update plugin from a Git revision | Supported | `opencode plugin add 'github:edugonch/agentic-engineering-tutor-system#<sha>'`; `opencode plugin list` |
| Provision global specialist profiles (`harness-builder`, `harness-researcher`, `harness-reviewer`, `harness-designer`) on plugin load | Supported | `src/global-agent-provisioner.js` |
| Read-only builder/reviewer readiness preflight | Supported | `harness_check_agent_readiness` |
| Deny role launch through the permission hook when readiness is missing/unknown | Supported | plugin permission hook |
| New/existing project initialization (full or governance-only) | Supported | `harness_initialize_project` |
| Bounded existing-project inventory | Supported | `harness_analyze_existing_project` |
| Knowledge archive: record, search, read, import with provenance/hashes | Supported | `harness_record_knowledge_artifact`, `harness_search_project_knowledge`, `harness_read_project_knowledge`, `harness_import_project_knowledge` |
| Story/Epic/WU contract validation (structure vs execution gate) | Supported | `harness_validate_story` |
| Packaged reference-library lexical search | Supported | `harness_search_knowledge` |
| Model routing per agent via config fragment | Supported | `.harness/OPENCODE-CONFIG-FRAGMENT.jsonc` |
| Cost/loop fuses: tool-call ceiling, delegation cap, repeated-mutation breaker, retry/output-token caps | Supported | env overrides in `README.md` |
| Jev shadow-mode decision signals (opt-in, never authoritative) | Supported (opt-in) | `HARNESS_JEV_*` |

### 1.2 Durable execution control plane

| Capability | Status | Surface |
|---|---|---|
| Owner-approved Epic → execution mandate | Supported | `harness_execution_controller` action `approve_mandate`, `authority_kind: OWNER_APPROVED_EPIC` |
| Derive + activate one WU under the mandate | Supported | action `activate_wu` (`origin: DERIVED`, `AUTHORIZED_BY_MANDATE`) |
| Cumulative budget ledger (used/reserved/available), funded reservations | Supported | actions `reserve`/`reconcile`/`release` |
| Dispatch lifecycle: reserve → prepare → launch → finish → reconcile; release and mark-ambiguous | Supported | actions `prepare_launch`, `record_launch`, `record_finish`, `reconcile`, `release`, `mark_ambiguous` |
| Append-only event log, fencing, CAS, lease, operation identity, restart replay/status/recover | Supported | `.harness/execution/controller/<id>/events.ndjson` |
| Freeze an immutable content-addressed candidate bound to the active WU | Supported | `harness_freeze_candidate`, action `record_candidate` |
| Deterministic verification with durable receipts | Supported | `harness_run_verification` (PASS requires full declared check coverage) |
| Candidate-bound review verdict with verification-evidence binding | Supported | action `record_review` |
| Close one WU (PASS review + settled dispatches + current candidate) | Supported | action `complete_wu` |
| Record a governed typed stop | Supported | action `block` (typed blocker classes) |
| Read-only recovery/status/verify inspection | Supported | actions `status`, `recover`, `verify` |

### 1.3 Supported autonomous happy path (the v1 ceiling)

```text
owner-approved Epic
  → approve_mandate
  → activate_wu (derived/authorized)
  → real harness-builder implements the WU
  → harness_freeze_candidate (immutable candidate)
  → harness_run_verification (deterministic receipts)
  → fresh independent harness-reviewer (candidate-bound PASS)
  → complete_wu
```

This exact path was demonstrated at the frozen baseline by E01 / WU-01
(`P3B-WU01`, 10 events, candidate
`cand-1ae9865d91d3dc232714bb2130695dbcc8745d4234df2f31796f3ef9c1c0bae4`, receipt
`verify-cd3e4ed8df44dfaae63db014660e7c01a696cb52ef8538641cec1f675d0fe8e8`,
`harness-reviewer` PASS, 241/241 suite).

## 2. Unsupported / experimental in v1

| Capability | Status | Note |
|---|---|---|
| `authorize_repair` and findings-driven repair B within one WU | EXPERIMENTAL / NOT RELEASED | Phase-4 bootstrap only; not runtime-accepted |
| `authorize_recovery` / `resolve_blocker` / recovery action claim+evidence | EXPERIMENTAL / NOT RELEASED / KNOWN LIVENESS DEFECT | See `docs/phase-4-final-status.md` |
| Autonomous handler for `CHANGES_REQUIRED` or a blocker | NOT SUPPORTED | Return control to the owner |
| Phase-4 fault-injection program and permission-denial negative probe | NOT SUPPORTED in v1 | Do not run for normal workflows |
| Cryptographic reviewer identity attestation | NOT SUPPORTED | Session-based identity only |
| Reviewing the same candidate twice / second review | NOT SUPPORTED | Deferred hardening |
| Automatic merge, deploy, release, npm publish, issue/branch creation | NOT SUPPORTED | Human ownership and merge policy remain project decisions |
| Broad process/network containment | NOT SUPPORTED | Explicit limitation |
| Windows `;` PATH semantics in `resolveBinary` | NOT SUPPORTED | Out of scope |

## 3. Known limitations (v1)

1. **No autonomous repair/recovery.** A real operational WU that gets
   `CHANGES_REQUIRED` or hits a blocker stops and returns control to the owner.
   This is the deliberate product boundary, not a bug to route around.
2. **Phase-4 recovery liveness debt** is retained exactly as documented; it is
   not solved in v1 and must not be "worked around" by weakening anti-replay
   ownership.
3. **Verification/review are per-candidate.** Only the current, unsuperseded
   candidate with a PASS bound to fresh receipts may close the WU.
4. **Cost is not a precise dollar ceiling.** The fuses bound loops, not spend.
   Configure provider-side spending limits as a second control.
5. **Baseline is Phase 3.** The Phase-4 branch and its amendments are preserved
   history, not part of the v1 release.
