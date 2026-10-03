# Project Charter — agentic-engineering-tutor-system

## Problem

Dirigir, restringir, verificar y recuperar agentes de IA de codificación durante tareas reales es difícil: el conocimiento metodológico está disperso y no existe un control-plane durable que gobierne la ejecución bajo una única autorización.

## Intended outcome

Un harness de orquestación story-governed y bounded para OpenCode, con control-plane durable recuperable, verificación independiente y gobierno de Work Units derivadas de un mandato aprobado por el owner.

## MVP boundary

Control-plane durable (event log autoritativo, fencing, presupuesto, lifecycle de dispatch), substrate de verificación, y un controlador autónomo de Work Units que demuestra una WU real end-to-end.

## Success evidence

PHASE_0/1/2 PASS sobre el control-plane durable; una WU real gobernada end-to-end bajo mandato (origen DERIVED, autorización AUTHORIZED_BY_MANDATE) con verificación independiente y cierre durable.

## Users and context

- Primary users: [OWNER INPUT REQUIRED]
- Operating context: [OWNER INPUT REQUIRED]
- Constraints (technical, legal, budget, time, accessibility): [OWNER INPUT REQUIRED]

## Explicit non-goals

- [List exclusions to protect the MVP boundary]

## Governance decisions

- Product owner: [OWNER INPUT REQUIRED]
- Research approval: [OWNER INPUT REQUIRED]
- WU activation authority: [OWNER INPUT REQUIRED]
- Current Harness gate: human review and merge remain per WU; this plugin does not merge or release.
- Future Epic-level gate: an option only after bounded automation has been validated and the Product Owner explicitly approves a separate release policy. It is not the initial/default policy.
- Project-specific merge/release policy: [OWNER INPUT REQUIRED]
- Per-WU active-time and per-Epic WU budgets: owner-approved for each Epic; no universal defaults.

## Decision history

Record date, decision, rationale, evidence, and superseded decision when applicable. Do not silently rewrite approved decisions.

### 2026-10-03 — Phase 4 closed as FAIL; Harness v1 scope frozen (owner, final)

- Decision: `PHASE_4 = FAIL` with reason `RECOVERY_LIVENESS_GAP`. Phase-4 autonomous bounded repair/recovery is EXPERIMENTAL / NOT RELEASED / KNOWN LIVENESS DEFECT. Harness v1 WILL NOT depend on it.
- Rationale: the real `P4-RESOLVEBINARY-ABSOLUTE-004` execution proved Build A → Candidate A → `BLOCKED_TOOLING` → one authorized recovery with durable `action_claim` before effect and durable `action_evidence` PASS, but settled the recovery dispatch before its required `tooling-ready` verification receipt. Afterwards verification was correctly rejected without a live dispatch, the recovery could not be repeated, and durable ownership correctly prevented a fresh authority reset — permanently stranding a legitimate WU. A real liveness defect in the recovery path, not a reason to weaken anti-replay ownership.
- Supported v1 autonomy ceiling: owner-approved Epic → derived/authorized WU → real builder → frozen candidate → deterministic verification → fresh independent reviewer → successful completion. `CHANGES_REQUIRED` or a blocker returns control to the owner; v1 does not autonomously repair or recover.
- Baseline: `dbe8beb0134e5a34d2e1f3ae92b9def6c3c07848` (accepted Phase 3 SHA).
- Evidence: `docs/phase-4-final-status.md`, `docs/phase-5-v1-capability-matrix.md`, `FINAL_RELEASE_REPORT.md`.
- Superseded: none. Phase-4 packets under `docs/proposals/phase-4-runtime*` remain immutable proposals and are retained as history.
