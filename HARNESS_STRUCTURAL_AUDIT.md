# HARNESS STRUCTURAL AUDIT — revisión arquitectónica y primera limpieza

**Fecha de auditoría:** 2026-10-20 (Costa Rica) / 2026-10-21 UTC  
**Repositorio:** https://github.com/edugonch/agentic-engineering-tutor-system  
**Baseline de `main`:** `a87d21b88377390b78a58bdba8429cc5b80ec222`  
**Rama de intervención:** `maintenance/harness-structural-cleanup-20261020`  
**Naturaleza:** auditoría estática profunda mediante conector GitHub y refactorización conservadora bajo CI. No es una ejecución del Harness/OpenCode.

## 1. Resumen ejecutivo

El objetivo original `ORCHESTRATE → BUILD → VERIFY → REVIEW → REPAIR/PASS → MERGE → NEXT` se mantiene reconocible, pero está repartido entre un entrypoint de ~1.088 líneas, un dispatcher de ~1.036 líneas, un reducer de ~1.365 líneas y distintos subsistemas con lecturas reiteradas del mismo event log. La sobrecarga dominante **potencial** proviene de búsquedas globales de controladores en hooks, replays y reescrituras completas de diarios, no de imports duplicados.

Se preserva íntegramente `docs/phase-4-final-status.md` y su resultado histórico `FAIL / RECOVERY_LIVENESS_GAP`. No se intervino en `alfran-epic05-delivery` ni `e0507-build-2`.

Una primera limpieza extrae consultas estrictamente de solo lectura (`summary`, `verify`, `audit_recovery`) desde `src/execution/controller-tool.js` a `src/execution/controller-inspection.js`. Se trasladan las implementaciones sin reescribir sus resultados. La reducción del dispatcher es de 1.036 a 883 líneas (~14,8 %); la reducción del sistema completo es **cero líneas de lógica equivalentes**: es una mejora de separación de responsabilidades, no una mejora de rendimiento demostrada.

## 2. Baseline, historial y limitaciones

- `main` inicial: `a87d21b88377390b78a58bdba8429cc5b80ec222`, merge de PR #69.
- PR #68: **OPEN**, sin merge, head `c18fd309382aa8d59a7beea80420ac1d238540ed`; diverge de `main` (adelante 1 commit, detrás 12 en la comparación consultada). Propuesta alternativa de recuperación.
- PR #69: **MERGED**, merge commit `a87d21b...`. Su descripción documentaba todavía "DRAFT / NOT READY TO MERGE" y pruebas negativas, OpenCode real y revisión independiente pendientes. La presencia de CI verde no subsana por sí sola esas condiciones.
- CI del SHA inicial: GitHub Actions `validate` concluyó **success** en Node 20, 22 y 24. Workflow: `.github/workflows/validate.yml` ejecuta `npm ci --ignore-scripts`, `npm run check` y dos suites de mutaciones.
- Se inventariaron mediante árbol Git completo `src/`, `index.js`, scripts y pruebas. Se inspeccionaron imports/exports, responsabilidades y puntos de entrada de los módulos JS fuente, con lectura focalizada de las rutas prioritarias.
- **No** se obtuvo un checkout local ejecutable: el contenedor no puede resolver `github.com`. No se ejecutaron Knip, jscpd, ESLint, dependency-cruiser, cobertura ni benchmarks de OpenCode. Las afirmaciones de sobrecarga son análisis del código, no latencias medidas.
- GitHub indicaba `main` sin protección de rama; esta observación no autoriza merges automáticos.

## 3. Arquitectura real (secuencia funcional)

| Etapa | Punto de entrada y componentes | Estado / efectos / condiciones |
| --- | --- | --- |
| ORCHESTRATE | `index.js`, agente `harness-orchestrator`, `controller-tool.js`, `project-knowledge.js`, `jit-contract.js` | Lee autoridad aprobada, `MANDATE_APPROVE`, `WU_CONTRACT_STAGE/BIND`, `WU_ACTIVATE`; niega autoridad ausente. |
| BUILD | `runExecutionController` reserve/prepare, `index.js` execute.before, `launch-binding.js`, `execution.js` | Reserva presupuesto, prepara dispatch, reclama su lanzamiento antes del side effect, controla identidad/lease/fence. |
| RECOVER / HANDOFF | `session-recovery.js`, `dispatch-handoff.js`, `supervisor.js`, `worker-budget.js` | Recupera identidad, entrega evidencia de child, administra bloqueos/reanudación. Resultados no equivalen a aceptación. |
| VERIFY | `candidate.js`, `candidate-registry.js`, `verification.js`, `verification-budget.js`, `verification-results.js` | Congela candidato y contrato, ejecuta checks, genera receipts inmutables de verificación. |
| REVIEW | `harness-reviewer` + `controller-tool.js` + `review-handoff.js` | Verifica identidad del reviewer, evidencia y veredicto mediante `RECORD_REVIEW`. |
| REPAIR/PASS | Nueva pasada builder dentro de la WU, `process-recovery.js`, `state.js` | Preserva restricciones, presupuestos, verificación y bloqueo; no procede sin reconciliar trabajo previo. |
| MERGE | `merge.js`, `merge-port.js`, `github-adapter.js`, `state.js` | Vincula PR/candidato, registra CI/head y verifica merge gobernado; efectos externos requieren evidencia. |
| NEXT | `complete_wu`, siguiente contrato derivado del mandato; `supervisor.js` | Continúa únicamente dentro de la secuencia/autoridad de Epic y con presupuesto real. |

El runtime tiene superficies distintas: hooks (`execute.before`, `execute.after`, `permission.evaluate`), herramientas, worker sessions, controlador persistente, conexión GitHub y lectura de fuentes aprobadas. No son intercambiables.

## 4. Mapa de responsabilidades y acoplamiento

| Componente | Responsabilidad verificada | Dependencias / acoplamiento notable |
| --- | --- | --- |
| `index.js` | Registro del plugin, herramientas, guardias y eventos | ~40 imports locales; concentra setup, esquemas y hooks. |
| `src/execution/state.js` | Replay, reducer, invariantes de eventos/budget/merge | ~57 casos `switch`; importa proceso, presupuesto, progreso, contratos. |
| `src/execution/controller-tool.js` | Dispatcher de ~41 acciones, preflight y commit | Numerosas dependencias de política, contratos, candidato, auditoría. |
| `src/execution/execution.js` | Fuente duradera, snapshot, acquire, CAS, commit, recover | Eventos/lease/mutex, replay por lectura. |
| `src/execution/session-recovery.js` | Identidad de sesiones, recovery, fence | API de sesiones + scan global de controladores para guard. |
| `src/execution/supervisor.js` | Outbox de continuación y reconciliación de turnos | Recorre controladores; acciones mediante leases. |
| `src/execution/continuation-driver.js` | Experimento Phase 0 de steps y probes | Registro de probe in-memory, no sustituye al supervisor de Epic. |
| `src/execution/progress.js` | Resúmenes/digests para continuar o diagnosticar | Dependencias de scope, política de contratos y observación. |
| `src/execution/merge.js` | Orquestación de efectos GitHub | Lógica de verificación de candidato/PR y estado duradero. |
| `src/project-knowledge.js` | Indexación/fuentes, aprobaciones, contratos WU | Módulo grande (~1.027 líneas); fuera del primer diff por riesgo de autoridad. |
| `src/decision/*` | Jev shadow-mode | Opt-in sin autoridad: mantener experimental y aislado. |

Se inspeccionaron imports explícitos del conjunto fuente sin observar un ciclo circular evidente en las rutas revisadas. Esto **no equivale** a resultado de dependency-cruiser, que no se ejecutó. Un `export` sin referencia textual no se consideró muerto: se examinó la posibilidad de entrypoints, herramientas y consumidores de plugin.

## 5. Hallazgos priorizados

### HSA-01 — HOT_PATH_OVERHEAD — Alta — Evidencia confirmada (impacto temporal sin medición)

**Ubicación:** `index.js:258-260,324-326`; `src/execution/session-recovery.js:31-45`; `src/execution/execution.js:86-93`.

**Evidencia:** en `execute.before` se llama `assertSessionNotOrphanFenced` antes de cada herramienta; también en la frontera de permisos. El helper enumera **todos** los controladores, crea controlador para cada directorio y ejecuta `snapshot()`. Cada snapshot valida el log y reconstruye la proyección.

**Causa:** resolver búsqueda child→fence mediante exploración global, sin índice duradero específico.

**Consecuencia:** trabajo de E/S proporcional al número de controladores/historial en una ruta muy frecuente; dos fronteras independientes podrían repetirlo. **No** concluir que una de las fronteras de seguridad sea innecesaria.

**Simplificación:** diseñar índice duradero child-session→fence con prueba fail-closed y estrategia de bootstrap/reconstrucción; *solo después* sustituir scans internos por lookup seguro. Conservar las dos barreras de autorización.

**Riesgo:** crítico si se introduce caché obsoleta o se omite un journal existente. **Verificación:** pruebas multi-proceso, restart, corrupted-index, fail-closed, carga real y benchmark.

### HSA-02 — HOT_PATH_OVERHEAD / ARCHITECTURAL_COMPLEXITY — Alta — Confirmada algorítmicamente

**Ubicación:** `src/execution/execution.js:86-93,105-108,235-240`, `src/execution/event-log.js:8-18,20-42`, `src/execution/state.js:135-156`.

**Evidencia:** `load()` lee y valida todos los eventos y `project(events)` aplica el reductor. `writeLog` valida y vuelve a serializar/escribir **todos** los eventos al confirmar cada commit. `applyEvent` hace `structuredClone` del estado por evento.

**Causa:** arquitectura orientada a replay completo sin snapshots incrementales ni append físico.

**Consecuencia:** incremento del coste con la longitud del historial, también para operaciones simples.

**Simplificación:** investigación separada sobre snapshot verificado de lectura o append duradero con límites de compatibilidad. No introducir esta reescritura en el diff conservador: cambia el dominio de durabilidad.

**Riesgo:** alto para atomicidad, hashes e integridad histórica. **Verificación:** crash injection, replay de fixtures históricos, auditoría de corrupción parcial y benchmark reproducible.

### HSA-03 — MIXED_RESPONSIBILITIES — Media/Alta — Confirmada; primera mejora aplicada

**Ubicación:** `src/execution/controller-tool.js:49-158,787-828` (baseline).

**Evidencia:** mismo dispatcher definía formateo completo de estado, verificación de log y auditoría de recuperación, además de decenas de ramas mutables de aprobación, presupuesto, lanzamiento y merge.

**Causa:** acumulación de acciones en un único punto de entrada.

**Consecuencia:** cambios de consulta obligan a revisar un archivo grande mezclado con mutaciones y controles sensibles.

**Simplificación aplicada:** extracción mecánica de `summary`, `verify` y `audit_recovery` a `src/execution/controller-inspection.js`; dispatcher delegado sin cambiar la salida. Sin alteración de event log, tipos de evento, políticas ni controlador.

**Riesgo:** importación o API incorrecta. **Verificación:** `npm run check`, suites de controller/CI sobre SHA exacto y revisión del diff.

### HSA-04 — ARCHITECTURAL_COMPLEXITY — Alta — Confirmada

**Ubicación:** `src/execution/state.js:151-1344`.

**Evidencia:** reducer único de ~1.200 líneas con más de 50 casos de eventos de proceso, supervisor, contratos, dispatch, review y merge.

**Causa:** distintas capacidades acumuladas en el reductor canónico.

**Consecuencia:** mayor superficie de cambio y regresión, especialmente con replay histórico.

**Simplificación diferida:** dividir en reducers de dominio **solo con pruebas diferenciales de replay**, manteniendo orden/eventos/errores/clone idénticos. **Riesgo:** alto. **Verificación:** golden historical fixtures, property tests de estado final y errores, nuevo vs anterior byte a byte.

### HSA-05 — EXPERIMENTAL_COMPLEXITY — Media — Confirmada

**Ubicación:** `index.js:153-163,542-573`; `src/execution/continuation-driver.js:25-43,75-90`; `src/decision/*`.

**Evidencia:** coexistencia de driver Phase 0 probe (`harness_continuation_spike`, activo como superficie aunque inerte sin registro de probe), supervisor duradero del Epic y experimento Jev shadow opt-in.

**Causa:** instrumentos de experimento y capacidades estables comparten setup/plugin registry.

**Consecuencia:** dificulta comprender cuál mecanismo controla realmente el avance de Epic y aumenta el tamaño del punto de entrada.

**Simplificación:** segregar registros de herramientas experimentales en módulo marcado como tal; validar que no cambian nombres públicos ni comportamiento de opt-out. No eliminar sin confirmar consumidores externos. **Riesgo:** medio. **Verificación:** tests de plugin wiring/probe + canary de runtime.

### HSA-06 — FUNCTIONAL_DEFECT / INSUFFICIENT_EVIDENCE — Alta — Conclusión limitada

**Ubicación:** `src/execution/session-recovery.js:174-298,301-346`; `index.js:340-360,583-586`.

**Evidencia:** `recoverOrphan` existe y se retorna desde `createSessionRecovery`, pero no se encontró registro del método como herramienta OpenCode en el entrypoint. PR #69 lo describía expresamente como pendiente de exposición.

**Consecuencia:** existencia de implementación no demuestra que el usuario de OpenCode pueda invocarla; el incidente `e0507-build-2` sigue sin prueba terminal.

**Propuesta:** decisión arquitectónica única sobre PR #68 y #69, pruebas de identidad + quiescencia + pending tools + fencing cross-process en el runtime original. **Excluido del diff de limpieza.**

### HSA-07 — TEST_DEBT — Alta — Evidencia de brecha específica

**Ubicación:** `.github/workflows/validate.yml:1-22`; `tests/execution/session-recovery.test.js`; PR #69.

**Evidencia:** CI verifica Node/tests/guardas de mutación, pero no existe confirmación de canary real OpenCode para la recuperación huérfana en ese SHA; PR #69 declaraba explícitamente pruebas negativas pendientes. Tests existentes sí cubren recuperación previa, identidad y bloqueos.

**Consecuencia:** `CI success` no prueba liveness ni integración real del método `recoverOrphan`.

**Propuesta:** añadir matriz adversarial antes de una futura reparación, sin reescribir fixtures ni relajar asserts. **Riesgo:** bajo al añadir tests, medio al tocar harness de test. **Verificación:** prueba en OpenCode y estado del child real.

### HSA-08 — DUPLICATION_CONFIRMED — Baja/Media — Confirmada a nivel de normalización

**Ubicación:** `src/execution/controller-tool.js:42-47`, `src/execution/session-recovery.js:10-14`, `src/execution/dispatch-handoff.js:21-25`.

**Evidencia:** tres normalizaciones de execution_id comparten sustitución de caracteres por `_` y prohibición de vacío/`.`/`..`, aunque difieren en mensajes de error. Hay asimismo varias lecturas/extracciones de respuestas `value?.data ?? value`.

**Consecuencia:** mantenimiento duplicado y posibilidad de divergencias futuras. **Propuesta:** helper puro parametrizable, **solo** cuando quede caracterizada la equivalencia de errores y contratos públicos. **Riesgo:** medio por textos/códigos de error. **Verificación:** tests de identidad adversarial y mensajes exactos.

### HSA-09 — ARCHITECTURAL_COMPLEXITY / HOT_PATH_OVERHEAD — Media/Alta — Confirmada

**Ubicación:** `src/execution/supervisor.js:150-169`; `src/execution/worker-budget.js:13-27`; `src/execution/launch-binding.js:56-85`; `src/execution/execution-query.js:5-23`.

**Evidencia:** varias operaciones reutilizan el patrón de enumerar directorios y ejecutar snapshots de todos los controladores. Son casos de consulta diferentes, algunos en hot path y otros solo durante recovery.

**Consecuencia:** repeated I/O, reglas de tratamiento de controladores corruptos/históricos distintas entre clientes.

**Propuesta:** separar un repositorio de consultas con semántica de errores especificada por caso; no convertir errores en "no encontrado". No fusionar barreras de seguridad ni tolerancia deliberada de terminales históricos. **Riesgo:** alto para fail-closed; **verificación:** tests de ENOENT, corrupción, historical terminal, concurrent updates, latencia.

### HSA-10 — GOVERNANCE / INSUFFICIENT_EVIDENCE — Alta — Verificación externa

**Ubicación:** PR #69, estado de GitHub de `main`.

**Evidencia:** PR fusionado con descripción "BLOCKING / DO NOT MERGE". GitHub informa que `main` no está protegida.

**Consecuencia:** discrepancia entre condiciones documentadas y aplicación real; el marco de autoridad declarado no se impone necesariamente por reglas de branch.

**Propuesta:** tratarlo como decisión operativa del propietario; activar revisión requerida/CI obligatorio conforme a la gobernanza que el propietario elija, sin inferir que es seguro reescribir historia. **Verificación:** revisión de rulesets, permisos efectivos y proceso de merge.

## 6. Código muerto confirmado

**Ninguna eliminación autorizada.** No se ha demostrado suficientemente una función sin consumidores en todos los mecanismos dinámicos del plugin y usuarios externos. `recoverOrphan` podría ser código aún no conectado; se clasifica como capacidad incompleta, **no** muerto demostrado. El barrel `src/execution/index.js` y los probes pueden servir consumidores externos: no se eliminan por ausencia de imports locales.

## 7. Duplicación y fronteras deliberadas

La normalización de IDs es duplicación limitada verificable. En cambio, la validación de una sesión en `execute.before`, `permission.evaluate` y `execution.acquire/commit` ocurre en fronteras de seguridad diferentes y **no** debe eliminarse por DRY. La oportunidad de rendimiento consiste en compartir un mecanismo correcto de *consulta*, nunca en retirar una barrera.

## 8. Rendimiento y métricas pendientes

Complejidades visibles de implementación:
- Fence lookup por tool/permiso: exploración de N controladores con replay de sus logs.
- Snapshot/read: lectura de E eventos + validación + proyección; `applyEvent` clona estado.
- Commit: replay de E eventos más serialización/escritura de E+1 eventos.
- Supervisor sobre turno terminal: barrido global antes de decidir a cuál ejecución pertenece.
- Worker budget sobre llamada de herramienta de especialista: barrido de controladores para mapear child→dispatch.

Estas son **propiedades algorítmicas**, no mediciones de tiempo ni token-cost. La telemetría de tokens actual es opt-in (`HARNESS_EFFICIENCY_TELEMETRY=1`) y el código reconoce que el coste monetario es desconocido sin precios suministrados.

## 9. Calidad de pruebas

Fortalezas: pruebas de event log/lease, recovery anterior, launch claim, presupuesto, sesiones, supervisor, merge y efectos externos; CI por tres versiones de Node; scripts de mutaciones. Deuda: no hay prueba runtime de OpenCode para la nueva recuperación, ni benchmark reproducible para scans/replay, ni resultado reproducible de cobertura/ciclos/código muerto a partir del checkout auditado. No se eliminaron ni relajaron pruebas.

## 10. Tres oportunidades de simplificación conservadora

1. **Aplicada:** aislar lecturas/invariantes del controlador en `controller-inspection.js` (traslado exacto, ~153 líneas fuera del dispatcher; sin alteración de estado).
2. **Diferida deliberadamente:** extraer el registro de herramientas de experimento/probe fuera de `index.js` preservando IDs y comportamiento por defecto; requiere pruebas OpenCode y wiring.
3. **Diferida deliberadamente:** unificar normalización de execution_id y lectores de runtime sin alterar textos de errores, coerciones ni permisos; requiere pruebas de caracterización explícitas.

No se incluyeron las optimizaciones de event log o fence lookup en el primer PR: son de más impacto, pero su riesgo de alterar seguridad/replay supera el límite de refactorización conservadora.

## 11. Arquitectura objetivo simplificada

```text
OPENCODE ADAPTER (hooks + tool registration)
    |
    +-- EXPERIMENTS (separados, opt-in / probes)
    |
    +-- ORCHESTRATOR / POLICY ADMISSION
         |
         +-- READ-ONLY INSPECTIONS / DIAGNOSTICS
         +-- COMMAND ROUTING (una acción → un handler)
         +-- DURABLE EXECUTION CORE (journal + CAS + lease + fence)
               |
               +-- DOMAIN REDUCERS (solo tras replay diferencial)
               +-- DISPATCH / HANDOFF / BUDGET
               +-- CANDIDATE / VERIFY / REVIEW
               +-- MERGE GATEWAY / EXTERNAL EVIDENCE
         |
         +-- NEXT WU (solamente autoridad y presupuesto existentes)
```

El flujo visible se simplifica como `ORCHESTRATOR → BUILDER → [VERIFY] → REVIEWER → MERGE → NEXT`. `VERIFY` sigue siendo gate obligatorio aunque no sea un agente autónomo. Recuperación, persistencia, control de presupuesto, CAS, fencing, aprobación y CI son **necesidades reales** por los riesgos observados; no se eliminan para obtener un diagrama corto.

## 12. Detalles de la primera modificación

**Antes:** `summary(controller)`, `verify(controller)` y la rama `audit_recovery` vivían en `controller-tool.js`, junto con acciones mutantes.

**Después:** nuevo `src/execution/controller-inspection.js` exporta `summary`, `verify`, `auditRecovery`. Se trasladó el cuerpo de las dos funciones y la rama de auditoría, se reemplazó el dispatcher de auditoría por una delegación y se quitaron imports que ahora pertenecen al módulo de inspección.

**Comportamiento esperado:** mismos resultados/errores de consultas, mismos hashes, mismas verificaciones de log, mismas operaciones de controller. No se tocó `src/execution/state.js`, `src/execution/execution.js`, `session-recovery.js` ni `index.js`.

**Verificación necesaria:** CI exacto del último head, revisión de diff para demostrar que la extracción es puramente mecánica y pruebas de status/verify/audit. Si CI falla, no concluir equivalencia ni mergear.

## 13. Riesgos y decisiones del propietario

- No resolver los PR #68/#69 durante esta limpieza.
- No reemplazar journal por append físico o caché sin plan explícito de compatibilidad y resiliencia.
- Requerir decisión sobre protección de branch, revisión independiente y restricciones de merge para evitar divergencia entre intención y aplicación.
- Elegir mediante evidencia de profiling qué optimización de hot path da más beneficio operativo antes de comenzar otra fase.
- No gastar ni trasladar presupuesto de Epics/WUs anteriores.

## 14. Estado final de esta intervención

- **Base:** `a87d21b88377390b78a58bdba8429cc5b80ec222`.
- **Rama:** `maintenance/harness-structural-cleanup-20261020`.
- **Cambios:** un módulo nuevo de solo lectura, dispatcher adelgazado y este informe.
- **Hallazgos:** HSA-01 a HSA-10, con grados distintos de confianza; sin código muerto confirmado.
- **Verificación local:** no realizada por falta de checkout con red. **CI:** debe comprobarse sobre el head exacto de la rama tras el último commit.
- **Estado del incidente ALFRAN:** no modificado ni declarado resuelto.
- **Siguiente paso mínimo:** revisión independiente del diff y resultado exacto de CI; fusionar únicamente tras aprobación vigente. Luego priorizar medición de scans y replay, **no** otra ronda indiscriminada de refactors.
