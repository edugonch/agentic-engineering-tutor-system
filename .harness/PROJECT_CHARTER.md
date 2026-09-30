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
