# Implementación y validación

Base: `6cca3cfc22494678e3f69bdb4b2ef691f5812e05`. Los archivos AUDITORIA.md y results.json describen esa base, no el comportamiento reparado.

## Cambios

| Hallazgo | Reparación | Evidencia |
|---|---|---|
| H1: proceso tratado como nueva autoridad | Política aprobada una vez por ejecución; bloqueo tipado TDD_ORDER; transición a reparación que no autoriza aceptación. Migración legacy ligada al fingerprint exacto del bloqueo aprobado. | Herramientas públicas, decisiones ajenas rechazadas, dos WUs consecutivas. |
| H2: RED sin evidencia estructurada | Obligación estructurada TDD validada, receipt negativo ejecutado, recuperación retrospectiva, aceptación exacta emitida por reviewer independiente. GREEN, CI y merge siguen siendo gates separados. | Receipts reales del runner; rechazo de setup/timeout/cancelación; candidato o evidencia cambiada invalida aceptación. |
| H3: solo última decisión inyectada | Todas las resoluciones del WU, política y recuperación pasan al contexto del worker. Campo singular conservado por compatibilidad. | Inspección real del worker con dos decisiones independientes. |
| H4: deadline anterior a observación remota | Lectura de PR/checks antes del bloqueo; recuperación de timeout con observación terminal y gates de merge ordinarios. Supervisor despierta una vez por progreso, sin anular cancelación. | SUCCESS/FAILURE/PENDING/inaccesible, timeout legacy, reinicio, deduplicación. |
| H5: verificación técnica requería nueva aprobación | Política puede delegar agregar checks desde fuente PROPOSED; conserva exactamente checks anteriores, setup, capacidades y entorno. Invalida bindings viejos y exige refreeze/review. | Herramienta pública, replay y rechazo de sustitución por comando trivial/capacidades nuevas. |
| H6: escalamiento excesivo en instrucciones | Investigación y reparación técnica reversible dentro del WU; desacuerdo no implica decisión de dueño; RED antes de implementación y recuperación explícita si se incumple. | Actualización de perfiles/skill y suite existente de instalación/preservación de perfiles. Comportamiento LLM real aún no medido. |
| H7: pruebas aisladas | Recorrido de dos WUs con mutación, GREEN, reviewer, reinicio, CI y merge mediante adaptador; seeds, replay y mutaciones de guards. | Suites y comando ampliado descritos abajo. |

Las sustituciones semánticas de comandos (por ejemplo, reemplazar un test global por scripts de workspace) siguen consumiendo una fuente ya aprobada. El código no puede demostrar equivalencia por una simple afirmación del modelo. La delegación automática implementada es aditiva y conserva los gates existentes.

## Validación reproducible

- `npm run check`: 511 pruebas PASS localmente en Node 24, incluidas las regresiones previas de identidad, leases, crash/replay, merge ambiguo, presupuesto de planificación y actualización de perfiles.
- `npm run test:recovery`: subconjunto dirigido a estas reparaciones.
- `npm run test:recovery:mutations`: baseline obligatorio y siete mutaciones aisladas; las siete detectadas: aceptación pendiente, alcance legacy, identidad del reviewer, contexto acumulado, CI pendiente, preservación de checks y binding del conjunto de evidencia.
- Exploración: 200 semillas fijas, 30 perturbaciones por semilla (checkpoints, lecturas y candidatos), conservando contabilidad y rechazo de aceptación pendiente. Es una exploración acotada, no prueba exhaustiva del espacio de estados.
- Replay congelado: `tests/execution/legacy-process-fixture.json`, generado ejecutando el código de la base. Se comparan integridad de eventos, hash de proyección y hash de progreso; no se reescribe la historia.
- Fixture sintético WU066: 73 aprobados, 15 extras, DEFERRED/activo, edición de staff e integridad de fuente. Seis mutaciones producen fallos de assertions relevantes y la restauración queda GREEN. **No ejecuta ni certifica el importador privado de ALFRAN.**
- CI ampliado a Node 20/22/24 con suite completa y mutaciones. La conclusión remota se comprueba sobre el head de la PR antes de integrar.

## Defectos adicionales encontrados durante el cambio

1. El merge VERIFIED de un WU anterior se conservaba como selección actual y bloqueaba la recuperación del siguiente. Se permite una integración anterior únicamente si está VERIFIED y su candidato pertenece al WU anterior completado; no se borra su registro.
2. Campos opcionales undefined en el nuevo evento RED cambiaban su representación al escribir JSON y rompían el hash de replay. Se omiten los campos no aplicables; la prueba pública registra RED y reconstruye el log.
3. Se rechaza un handoff truncado como aceptación de proceso, evitando aceptar un veredicto sin el contexto completo.
4. Se liga el nuevo timeout a la revisión que lo terminó, evitando confundir un bloqueo posterior con aquel vencimiento.

## Adopción y límites

Las ejecuciones históricas conservan su política. El orquestador normaliza una autorización general **ya concedida** en un artifact APPROVED `process_policy`, ejecuta `adopt_process_policy` una vez y usa `start_process_recovery` en las WUs cubiertas. No traslada unilateralmente la excepción específica de WU063 a WU066. Un bloqueo legacy requiere su fingerprint exacto en esa autoridad; los bloqueos de producto, scope, seguridad y permisos no se dispensan.

Un receipt RED prueba que un comando falló sobre un baseline congelado antes del registro del candidato final; no demuestra todo el orden de edición fuera del runtime. La suficiencia de las mutaciones y la diferencia entre un fallo de assertion y un módulo ausente se evalúan en revisión independiente, no mediante un detector textual que pretenda entender todas las pruebas.

No se ejecutó canary del proveedor ni matriz conductual LLM (escenarios 29/30 del plan en su parte de runtime real): esta sesión no expone el servicio OpenCode del usuario. Tampoco se modificaron el estado durable de ALFRAN, PR168, su presupuesto ni su catálogo. Tras actualizar el plugin y reiniciar ese servicio, debe verificarse la política/contexto realmente cargados y continuar el mismo candidato/ejecución. Los tests con adaptadores no sustituyen esa validación operacional.
