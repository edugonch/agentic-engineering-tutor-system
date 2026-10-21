---
artifact_id: "WU-HARNESS-CONTINUITY-01"
artifact_type: "work_unit"
status: "APPROVED"
created_at: "2026-10-21"
source_refs:
  - "epic-harness-continuity-readiness-20261021"
  - "HARNESS_CONTINUITY_TECHNICAL_ASSESSMENT_2026-10-21.md"
parent_refs:
  - "epic-harness-continuity-readiness-20261021"
---

# WU-HARNESS-CONTINUITY-01 — Admission + Review Evidence Readiness

Epic: `epic-harness-continuity-readiness-20261021`
Origin: PLANNED
Owner activation: PENDING
CHILD_WORK_UNITS_ALLOWED: NO

## Resultado único verificable

Una Work Unit puede evaluarse antes de BUILD respecto a la cobertura de sus checks, sin bloqueos falsos en contratos históricos, y el reviewer puede consultar un paquete de recibos exactos y vigentes del candidato congelado sin ejecutar verificaciones adicionales. Es una sola mejora vertical del handoff **admisión → verificación → review**.

## Acceptance criteria (identificadores de esta WU)

- **C01 — Retrocompatibilidad:** contratos históricos sin `acceptance_coverage` no cambian de hash ni pasan automáticamente a `BLOCKED`; el diagnóstico distingue `COVERAGE_NOT_DEMONSTRATED` de `CONTRACT_VIOLATION` y no presenta cobertura funcional falsa.
- **C02 — Cobertura estricta explícita:** nueva metadata versionada (`schema_version: 1`, `mode: REQUIRED`, universo explícito de IDs de criterios y mapeo de criterios a check IDs declarados) exige mapeo completo, sin duplicados, sin referencias a setup o checks inexistentes; informa `REQUIRED_CHECK_UNMAPPED` cuando corresponda. El modo `ADVISORY` o la ausencia de metadata no impone el mismo bloqueo. Incorporar la metadata nueva al hash contractual solo cuando está presente.
- **C03 — Preflight proporcional:** no exigir DB ni browser para documentos; no aceptar `npm test` como prueba de concurrencia PostgreSQL; distinguir herramientas disponibles, no comprobadas, ausentes, no aplicables y decisiones pendientes. No deducir semántica mediante regex en Markdown ni conceder nueva autoridad. Señalar `WRITE_SCOPE_CONFLICT` únicamente ante conflicto explícito verificable.
- **C04 — Recibos exactos:** `prepare_review_evidence(execution_id, wu_id, candidate_id)` identifica candidato, hashes, checks requeridos, IDs reales de recibos PASS/FAIL y checks sin evidencia; rechaza y explica recibos de otro candidato, contrato, check inesperado, manipulación o ID inexistente. Nunca sintetiza IDs.
- **C05 — Read-only y frescura:** esa consulta no adquiere lease, no corre checks ni setup, no escribe archivos/eventos/recibos. Distingue evidencia vigente de `UNKNOWN/NEEDS_RECHECK` conforme a política aplicable y configuración material; la coincidencia de candidate/check/hash sin prueba de frescura no garantiza reutilización.
- **C06 — Preservar gates:** `record_review`, cobertura requerida de `state.js`, inmutabilidad de recibos, fencing, merge y replay histórico mantienen su semántica. Integración con `operational_status` y `inspect_next_wu_contract` sin otro controlador.
- **C07 — H-03 condicional:** antes de corregir, reproducir contra la regex real `This is NOT a WU_CONTRACT_REQUIRED condition.` y otras frases contradictorias que sí coincidan. Si y solo si cabe corrección acotada sin tocar PR #68, impedir que texto legacy autorice una transición sensible; si no, dejar causa pendiente. La frase `This is NOT a frozen verification setup timeout.` por sí sola **no** sirve para demostrar el fallo del regex contractual.
- **C08 — Evidencia final:** tests dirigidos y adversariales, integración relevante, paquete, replay histórico y CI Node 20/22/24 en head exacto; revisión independiente real, no simulada. Las pruebas específicamente nuevas deben demostrar C01–C07 según las funciones efectivamente implementadas; no basta con interpretar `npm test` como cobertura universal.

## Alcance de escritura permitido

- `src/execution/jit-contract.js`, `src/execution/verification-contract.js`, `src/execution/verification.js` (solo validación contractual si estrictamente necesario), `src/execution/controller-tool.js`, módulos auxiliares **puros/read-only** pequeños en `src/execution/` y pruebas relacionadas en `tests/execution/`.
- `index.js` exclusivamente si es imprescindible exponer la consulta read-only al plugin; documentación mínima de API.
- `src/execution/progress.js`, `src/execution/authority-triage.js` o `src/execution/supervisor.js` solo tras reproducir H-03 y comprobar que la corrección es mínima e independiente. `state.js` solo lectura/test de compatibilidad, **no modificar su lógica de replay**.
- No alterar checks existentes ni reducir cobertura para pasar CI.

## Fuera de alcance

ALFRAN y todos sus archivos/controladores; PR #68; `session-recovery.js`, recuperación huérfana, dispatch orphan/abandon, journal y schemas persistentes, runner global, caché compartida, permisos, políticas de merge y presupuesto, otras Epics/WUs, arquitectura general.

## Dependencias y modo de trabajo

- Una aprobación del propietario sobre fuente y hashes exactos de Epic/WU, seguida de promoción controlada `PROPOSED` → `APPROVED`, indexación de fuentes y `approve_mandate` válido. No activar por inferencia.
- El controlador mantiene secuencia única. Una vez autorizado, implementar **H-01 + H-02** en la misma rama/WU; H-03 únicamente si pequeño y reproducido; un PR DRAFT y hasta dos reparaciones dentro de esta WU.
- Antes de BUILD, contrastar la capacidad de las herramientas y el contrato activo; no convertir la ausencia de un test que el propio builder debe crear en una prohibición circular de BUILD. Distinguir check declarado ejecutable, evidencia de cobertura pendiente y verificación final insuficiente.

## Contrato técnico de ejecución

Los comandos de abajo existen hoy en `package.json`; su presencia solo define mecanismos de verificación, **no certifica semántica de aceptación**. Las pruebas dirigidas nuevas quedan exigidas por C08 dentro de la suite antes del PASS; su ruta exacta no se inventa antes de implementarlas. `npm ci --ignore-scripts` coincide con el setup declarado por CI. Techo 5.400 s compartido con todas las fases y reparaciones. No se autoriza usar tiempo adicional.

execution_contract: {"active_seconds":5400,"verification_contract":{"setup":[{"id":"npm-ci","program":"npm","args":["ci","--ignore-scripts"],"timeout_ms":300000}],"commands":[{"id":"harness-check","program":"npm","args":["run","check"],"timeout_ms":300000},{"id":"recovery-mutation-guard","program":"npm","args":["run","test:recovery:mutations"],"timeout_ms":300000},{"id":"sources-mutation-guard","program":"npm","args":["run","test:sources:mutations"],"timeout_ms":300000}],"environment":{"network_policy":"UNRESTRICTED"},"capabilities":[]},"process_obligations":[]}

## Presupuesto, revisión y merge

Máximo Epic/WU: **5.400 segundos acumulados**; una WU; hasta dos reparaciones; un solo PR DRAFT. `merge_policy: human`, sujeto a autorización efectiva posterior y gates. Ningún PASS de CI sustituye revisión independiente. Si la implementación queda parcial, comunicar `PARTIAL`, no inventar aceptación.

## Condición de parada

Parar por presupuesto, alcance, autoridad, recibos no confiables, necesidad de mutar el journal/controlador histórico o dependencia de PR #68. Conservar rama/PR DRAFT, evidencia y causa exacta. No añadir WUs ni aumentar segundos.

## Handoff (a completar solo con evidencia real)

Commit: PENDING. Candidate: PENDING. Receipts: PENDING. Tests: NOT_RUN. Independent review: NOT_RUN. CI: NOT_RUN. PR: NOT_CREATED. Merge: NOT_AUTHORIZED.
