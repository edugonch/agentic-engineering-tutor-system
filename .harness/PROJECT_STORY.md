# agentic-engineering-tutor-system — Project Story

## The story so far

This is the durable narrative for the project. Keep it concise, update it when owner decisions change the direction, and preserve prior milestones rather than rewriting history.

### Opening premise

Dirigir, restringir, verificar y recuperar agentes de IA de codificación durante tareas reales es difícil: el conocimiento metodológico está disperso y no existe un control-plane durable que gobierne la ejecución bajo una única autorización.

### Intended destination

Un harness de orquestación story-governed y bounded para OpenCode, con control-plane durable recuperable, verificación independiente y gobierno de Work Units derivadas de un mandato aprobado por el owner.

### First meaningful release (MVP)

Control-plane durable (event log autoritativo, fencing, presupuesto, lifecycle de dispatch), substrate de verificación, y un controlador autónomo de Work Units que demuestra una WU real end-to-end.

### Evidence that the story is moving in the right direction

PHASE_0/1/2 PASS sobre el control-plane durable; PHASE_3 (3A + 3B) PASS: una WU real (`resolveBinary` executable-bit) gobernada end-to-end bajo mandato (origen DERIVED, autorización AUTHORIZED_BY_MANDATE) con builder y reviewer reales, candidate inmutable, verificación reproducible y cierre durable.

## Chapter sequence

List finite Epics in narrative order. The project may continue beyond the currently known chapters; every individual Epic still needs a finite ending.

| Chapter | User change | Start condition | Ending / demo | Status |
|---|---|---|---|---|
| E01 | First governed WU end-to-end (`resolveBinary` executable-bit) | PHASE_0/1/2/3A = PASS | WU-01 `complete_wu` with a PASS review bound to verification receipts | COMPLETE |

## Continuity notes

- What each completed chapter made possible: E01 demonstrated the Harness governing a real WU end-to-end — owner-approved Epic → `approve_mandate` → DERIVED WU → `harness-builder` → immutable candidate → reproducible verification → `harness-reviewer` (independent PASS) → durable closure, with zero human intervention between activation and completion.
- Open questions that do not block the next step: reviewer identity attestation; second review of the same candidate; per-WU dispatch settlement (all deferred to later hardening).
- Changes to the intended destination: NONE.
