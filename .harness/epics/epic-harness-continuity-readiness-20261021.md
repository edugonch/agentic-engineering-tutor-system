---
artifact_id: "epic-harness-continuity-readiness-20261021"
artifact_type: "epic"
status: "APPROVED"
created_at: "2026-10-21"
source_refs:
  - "HARNESS_CONTINUITY_TECHNICAL_ASSESSMENT_2026-10-21.md"
parent_refs: []
---

# Epic — Harness Continuity Readiness

## Propósito y resultado único

Hacer que el Harness prepare la admisión de la siguiente Work Unit y el paquete de evidencias del reviewer antes de que surjan bloqueos evitables. Conservar como única autoridad el controlador duradero y el ciclo `SELECT → BUILD → VERIFY → REVIEW → REPAIR/PASS → MERGE → COMPLETE → NEXT` ya integrado por PR #71. No crear otro sistema de orquestación.

## Inicio y dependencias

- Repositorio exclusivo: `edugonch/agentic-engineering-tutor-system`.
- Base de referencia verificada: `main` en `2c238968b07e95647b3a86aa7a80fc2d7c9bc466`, que contiene PR #71. Antes de crear rama, comprobar únicamente si `main` avanzó y rebasar de manera segura; no repetir auditoría general.
- PR #68 queda fuera y no debe fusionarse ni servir de base.
- Requiere aprobación verificable del propietario para **estas fuentes exactas** y techo de 5.400 segundos; la fuente con `PROPOSED` no confiere autoridad de ejecución.
- Requiere promoción controlada a fuente `APPROVED` e indexación conforme al mecanismo de gobernanza; después, `approve_mandate` y admisión de la única WU por el controlador. La aprobación del contenido no equivale por sí sola a activación, dispatch ni merge.

## Secuencia única e inmutable

| Orden | Work Unit | Resultado | Dependencias |
|---|---|---|---|
| 1 | `WU-HARNESS-CONTINUITY-01` | Preflight de cobertura retrocompatible y paquete read-only de evidencias para review | Esta Epic aprobada; `main` compatible con PR #71 |

No crear WUs hijas, de reparación, de coordinación o de seguimiento.

## Alcance aprobado al activarse

- **H-01 (principal):** cobertura estructurada optativa y versionada; no bloquear automáticamente contratos históricos sin `acceptance_coverage`. Separar `COVERAGE_NOT_DEMONSTRATED` de una infracción verificable. Solo exigir mapeo completo cuando el contrato declare expresamente modo `REQUIRED`; entonces usar `REQUIRED_CHECK_UNMAPPED` para omisiones demostradas. Ni `npm test` ni keywords de Markdown acreditan por sí solos capacidades o semántica de aceptación.
- **H-02 (principal):** inspección estrictamente read-only de recibos reales del candidato y contrato exactos, con IDs auténticos, PASS/FAIL/faltantes, rechazo de mismatch/tampering y vigencia explícita. Reutilizar solo evidencia permitida y aún válida; no repetir pruebas porque se perdió su identificador.
- **H-03 (condicional):** solo si una prueba negativa reproduce el error de clasificación existente, empezando por `This is NOT a WU_CONTRACT_REQUIRED condition.`, y si el arreglo es pequeño, seguro y ajeno a PR #68. Si no, documentar el hallazgo sin modificar recovery.
- H-04/H-05/H-06: caracterización limitada de solo lectura si es practicable; no son requisitos de implementación ni autorizan optimizaciones del runner/journal.

## Límites estrictos

No intervenir ALFRAN, `alfran-epic05-delivery`, su controlador, PR #68, recuperación huérfana, journal append-only, replay histórico, presupuestos, permisos, merge gates, setup global ni caché del runner. No inventar decisiones del propietario ni modificar contratos de ALFRAN. No crear una segunda fuente de verdad. Máximo un PR técnico **DRAFT**, máximo dos ciclos de reparación en la **misma** WU.

## Demostración terminal y aceptación de Epic

1. Contratos históricos sin metadata de cobertura mantienen su comportamiento y sus hashes; el preflight reporta cobertura no demostrada, no un BLOCKED nuevo por ausencia de campo.
2. Un contrato nuevo que declara modo `REQUIRED` rechaza mapeos incompletos o checks inexistentes; uno documental no exige PostgreSQL/navegador, y `npm test` genérico no acredita dos escritores PostgreSQL.
3. La consulta read-only devuelve solo recibos inmutables existentes del candidato, check y contrato exactos, conserva la vigencia y no ejecuta pruebas ni escribe eventos, lease o recibos.
4. El flujo de PR #71 continúa operativo; tests adversariales, validación del paquete y fixtures de replay aplicables pasan sin debilitar gates.
5. CI exact-head en Node 20, 22 y 24 y revisión independiente real del commit exacto constan como evidencias separadas. Un canary OpenCode no ejecutado se reporta PENDING, nunca PASS.
6. Existe un solo PR DRAFT. Sin aceptación independiente y autorización de merge aplicable permanece DRAFT; no se fusiona automáticamente.
7. Si no se completa todo el alcance dentro del presupuesto, informar `PARTIAL` o `BLOCKED` con evidencias; no añadir WUs ni extender tiempo automáticamente.

## Autoridad, presupuesto y merge

- Techo absoluto acumulado para esta Epic: **5.400 segundos (90 minutos)**; `max_wus=1`, sin incremento automático y sin utilizar la autorización separada de 14.400 segundos.
- Política de merge solicitada: **`human`**. El propietario autoriza solo el trabajo acotado al aprobar estas fuentes; **no** autoriza mediante ello fusionar PR, relajar CI ni omitir revisión independiente.
- CI de tres versiones de Node es una obligación terminal explícita. Los nombres `validate (20)`, `validate (22)` y `validate (24)` se verificaron en un run anterior de GitHub Actions; para el nuevo PR se exigirán nuevamente sobre su head exacto, sin reutilizar el PASS anterior.

execution_mandate: {"max_wus":1,"total_seconds":5400,"wu_sequence":["WU-HARNESS-CONTINUITY-01"],"merge_policy":"human","required_ci_checks":["validate (20)","validate (22)","validate (24)"]}

## Condición de parada

Parar por presupuesto agotado, falta de autorización válida, cambio de alcance, evidencia de identidad/vigencia desconocida que se pretenda usar para PASS, solapamiento con PR #68 o necesidad de tocar recuperación histórica. Conservar el estado y reportar causa específica. La Epic se cierra solo con su WU aceptada y las pruebas, revisión, merge autorizado (si procede) y cierre durable correspondientes.
