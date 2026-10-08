# Auditoría integral de continuidad y control del Harness

Fecha: 8 de octubre de 2026. Repositorio: `edugonch/agentic-engineering-tutor-system`.
Código auditado: `f094b038f1f036a55eb6f375fcac6d15678c8792` (main tras PR #33).

## Dictamen

El controlador todavía no ofrece una ejecución autónoma de Epic suficientemente fiable para el uso sostenido que se espera de él. Los bloqueos sucesivos no se explican solamente por prompts débiles o por falta de autorización del usuario. Hay una combinación de transiciones incompletas, contabilidad conservadora presentada como tiempo consumido, límites de agentes desconectados del presupuesto, preflight incompleto y pruebas que no ejercitan el runtime completo.

Los fixes #29–#33 sí cubrieron defectos concretos. Los registros aportados confirman recuperación de identidad, lectura de handoff y aplicación de ampliación de presupuesto. Sin embargo, fueron reparaciones de rutas individuales. No demostraron que el ciclo completo BUILD → evidencia → REVIEW → corrección → CI → MERGE → siguiente WU pudiera avanzar y recuperarse sin intervención repetida.

Además de interrupciones innecesarias, existen controles incompletos en el sentido contrario: una reanudación de merge puede ignorar un bloqueo nuevo, y la asociación entre el candidato revisado y el contenido del head de PR no se verifica. Por eso eliminar todos los bloqueos o dar instrucciones más insistentes no es una solución adecuada.

**Recomendación:** reparar el ciclo de ejecución como una unidad, con pruebas de transiciones y de recuperación completas. No seguir usando ALFRAN como único lugar donde aparecen las combinaciones que faltan en las pruebas.

## Alcance y método

Se revisaron máquina de estados, controlador público, reservas/reconciliación, leases/mutex/log durable, recuperación de sesiones, handoff, registro de lanzamientos, ownership de agentes, guardas de repetición, continuación, perfiles, provisión de perfiles, knowledge/decisiones, validación de contratos, candidatos/registro/workspaces, verificación/receipts, readiness, revisión/PR/CI/merge y CI del repositorio. Se contrastaron instrucciones de agentes con runtime y documentación. Se consultó el historial del código para ubicar el origen de las políticas de reserva y límites de agentes. Los anexos de diseño de prompts y testing aportados se usaron como referencia metodológica, no como contrato de OpenCode.

Evidencia:

- `npm run check`: **421 pruebas pasan**, 0 fallidas.
- `node docs/audits/2026-10-08/reproduce.mjs`: **13 reproducciones** de comportamientos problemáticos, todas completadas. Resultados en `results.json`.
- Las reproducciones crean y borran proyectos temporales. Las operaciones remotas usan adaptadores simulados; no hubo merges reales, cambios de estado de ALFRAN ni acceso a credenciales.
- No se modificó código de ejecución durante esta auditoría. Los nuevos archivos son este informe, el reproductor y sus resultados.
- No se tuvo acceso al OpenCode autenticado del usuario, a su configuración efectiva ni al checkout vivo de ALFRAN. Por tanto, esta auditoría confirma defectos del código y analiza los logs aportados, pero no atribuye cada parada histórica a un defecto específico sin evidencia adicional.
- Una reproducción que termina sin error significa que el defecto se reprodujo; **no** que sea un comportamiento aceptable. No es una suite de aceptación del producto.

Prioridades: **P0** compromete una garantía esencial antes de un efecto externo; **P1** bloquea o degrada seriamente la continuidad; **P2** limita diagnóstico, evidencia o confiabilidad operativa.

## Hallazgos

| ID | Prioridad | Hallazgo | Evidencia |
|---|---|---|---|
| F01 | P0 | Reanudar un merge STARTED omite comprobar un bloqueo nuevo | A04 |
| F02 | P0 | No se demuestra que el head del PR contiene el candidato revisado | A13 + lectura de adapter |
| F03 | P1 | Reconciliar cobra toda la reserva, sin medición de ejecución por el camino público | A01 |
| F04 | P1 | Activar una WU no incorpora su límite original de tiempo a la máquina | A01 + activate_wu |
| F05 | P1 | Especialistas tienen cortes de pasos; no existe continuación productiva durable del Epic | Perfiles + continuation-driver |
| F06 | P1 | La matriz de bloqueos todavía tiene estados sin recuperación soportada | constants/state/controller |
| F07 | P1 | Release no elimina la asociación efímera de lanzamiento | A02 + index.js |
| F08 | P1 | No se puede registrar otra revisión del mismo candidato | A03 |
| F09 | P1 | PR/base cambiante y merge STARTED pueden dejar la integración sin salida | A05, A06 |
| F10 | P1 | Workspace de verificación no prepara dependencias y fuerza timeout de 30 s | A07 + runner |
| F11 | P1 | Readiness puede decir READY con cero presupuesto y sin entorno real de verificación | A11 + wiring |
| F12 | P1 | El contrato ejecutable y sus obligaciones dependen de traducción del modelo | freeze/record_candidate/story-validator |
| F13 | P1 | La guarda de no progreso puede impedir recuperarse de un cambio externo real | A08 |
| F14 | P1 | Selección de CI por nombre ignora intentos/identidad; API no pagina | A12 + github-adapter |
| F15 | P2 | verify no comprueba los hashes de operaciones del log | A09 |
| F16 | P2 | Recuperación depende de contexto compactable y devuelve handoffs muy voluminosos | recovery/reader + logs del usuario |
| F17 | P2 | Actualizar plugin no garantiza instrucciones efectivas actualizadas | provisioner/steps/readiness |
| F18 | P1 | La cobertura actual no acredita un Epic real sostenido en OpenCode | workflow + pruebas E2E simuladas |
| F19 | P1 | completed no actúa como cierre estructural universal | A10 + applyEvent |

### F01 — Gate de merge omitido al reanudar

Fuente: `src/execution/merge.js`, `runMergeCandidate`, condición `if (!state.merge)`; `src/execution/state.js`, eventos `MERGE_RECORD` y `MERGE_VERIFY`.

`canStartMerge` se consulta solo cuando todavía no hay registro de merge. `MERGE_START` se escribe antes de comprobar CI remoto. Si CI remoto falla, queda STARTED. En el siguiente intento, el gate se omite. A04 registra `BLOCKED_SECURITY` después del primer fallo y comprueba que el reintento invoca el merge simulado y devuelve `merged`, con el bloqueo todavía activo.

Corrección: separar observación de un efecto remoto ya ocurrido de autorización para producir un efecto nuevo. Consultar estado vigente inmediatamente antes de un nuevo merge; conservar revisión/fencing y revalidar cambios concurrentes. Un merge que ya ocurrió debe poder registrarse fielmente sin que eso autorice repetir la acción bajo un bloqueo.

### F02 — Falta el vínculo entre bytes revisados y commit remoto

Fuentes: `index.js`, `harness_freeze_candidate`; `src/execution/controller-tool.js`, `bind_pr`; `src/execution/github-adapter.js`; `src/execution/candidate.js`.

El candidato se calcula sobre rutas elegidas por el llamador. `bind_pr` recibe head/base como parámetros y no verifica el árbol Git remoto contra el árbol del candidato. El adapter consulta metadatos del PR, checks y merge, no el contenido del commit. A13 completa el merge simulado con un head arbitrario sin posibilidad de comprobar sus archivos. Esto prueba la ausencia del vínculo, no que ALFRAN haya integrado código incorrecto.

Corrección: materialización Git reproducible y recibo que vincule candidato, árbol completo y commit/head. Antes de integrar, verificar ese vínculo contra el remoto. No basta con fijar el SHA aportado por el modelo.

### F03 — Presupuesto reservado se convierte en consumo nominal

Fuentes: `src/execution/execution.js`, `reconcileOne`/`reconcileAll`; `src/execution/state.js`, `DISPATCH_RECONCILE`; `src/execution/controller-tool.js`, `reconcile`.

La regla conservadora viene de `20594fe`: si el consumo es desconocido, cobrar la reserva evita convertir una ejecución incierta en costo cero. Ese objetivo es válido. El problema es que el camino público de reconciliación no aporta ninguna medición y siempre cae en ese fallback. Un despacho que solo inspecciona y termina puede agotar toda la reserva. A01 reserva 3600 s y ejecuta inmediatamente launch/finish/reconcile: se contabilizan 3600 s.

No se demuestra que los cargos históricos de ALFRAN sean falsos: son cargos conservadores, no mediciones probadas de tiempo activo. El modelo no debe corregirlos por intuición.

Corrección: especificar qué mide el presupuesto (tiempo activo por worker, tiempo de pared, o ambas métricas), capturar evidencia runtime y distinguir medido/reservado/estimado/desconocido. Mantener fallback conservador para incertidumbre, con una transición auditada de corrección basada en evidencia. Evitar doble cobro entre PHASE y dispatch si ambas rutas miden el mismo intervalo. Reservar capacidad explícita para revisión/CI/cierre, no consumirla toda en BUILD.

### F04 — Contrato WU y presupuesto del controlador separados

Fuentes: `activate_wu`, `WU_ACTIVATE`, `wuBudgetUsage`, `validateStoryFile`.

El validador textual reconoce `Active-time limit`, pero `activate_wu` no carga ese contrato ni extrae el límite. La WU proyectada no recibe presupuesto original. `wuBudgetUsage` solo tiene techo cuando existe una ampliación estructurada. A01 incluye un artefacto con límite 2400 s, activa WU y reserva 3600 s; la máquina informa techo null y verify PASS. El fixture no pretende acreditar un contrato documental completo: muestra que activación ni siquiera consulta ese documento.

Corrección: compilar y fijar contrato/version/hash al activar, incluyendo presupuesto original, obligaciones y verificación. Las ampliaciones deben versionar el mismo objeto efectivo. No dejar que el modelo descubra después de gastar que un documento y el controlador discrepaban.

### F05 — Cortes de especialistas sin continuidad equivalente

Fuentes: perfiles `harness-builder` (20), `harness-reviewer` (10), `harness-researcher` (8), `harness-designer` (18); `src/orchestrator-steps.js`; `src/execution/continuation-driver.js`.

El fix retiró el default 12 del orquestador; los especialistas siguen teniendo límites. Su origen antecede al controlador durable (`c8a0d74`), con intención de acotar iteraciones. El driver actual declara expresamente que es un spike de Phase 0, se activa solo para sesiones probe y limita continuaciones por defecto a una. No constituye un supervisor productivo del Epic. Quitar el corte del orquestador no resuelve un builder que corta a mitad del trabajo.

No se confirmó que los cortes de ALFRAN fueran exactamente por steps: hace falta el motivo terminal del runtime. Sí está confirmada la configuración y la ausencia de continuación general.

Corrección: resultado tipado `completed / yielded / failed / blocked`, checkpoint antes de ceder y reanudación soportada con el mismo mandato. Los límites pueden proteger recursos si causan una pausa recuperable, no un bloqueo de negocio ni un cobro opaco de toda la WU. No activar el spike sin validación como sustituto de ese diseño.

### F06 — Recuperación incompleta por clase y etapa

Fuentes: `constants.js`, `applyEvent`, `amend_mandate`, `amend_wu_budget`, `resolve_authority_blocker`.

| Bloqueo | Ruta actual | Hueco |
|---|---|---|
| BLOCKED_TOOLING / EXTERNAL_FACT / ARCHITECTURE | clear_blocker con texto | No determina de forma estructurada qué evidencia demuestra reparación |
| BUDGET_EXHAUSTED | amend_wu_budget | Solo WU activa, despachos liquidados y capacidad Epic disponible; no ampliación/rebase del Epic |
| BLOCKED_AUTHORITY | resolve_authority_blocker | Solo WU activa e incompleta; no resuelve autoridad previa a activar WU o al nivel Epic |
| NO_PROGRESS | Ninguna | Permanece terminal aunque el dueño aporte nueva evidencia o cambie la causa |
| BLOCKED_SCOPE | Ninguna | Se exige rebase en instrucciones, pero no hay transición general de rebase |
| BLOCKED_PERMISSION / SECURITY | Ninguna | No se deben eludir; falta describir el procedimiento soportado para reparar y validar legítimamente la causa |

Los fixes recientes preservan correctamente el historial, pero agregan rutas individuales. `amend_mandate` explícitamente prohíbe cambiar presupuesto y número máximo de WUs. Una nueva autorización en texto no crea una transición que no existe.

Corrección: matriz exhaustiva causa/alcance/evidencia/actor/transición, distinguiendo espera externa, pausa recuperable, decisión requerida y denegación efectiva. `status` debe mostrar acciones legales y requisitos faltantes. Resolver una decisión ya otorgada no debe volver a pedirla. Permisos efectivos y controles de seguridad mantienen su autoridad.

### F07 — Memoria de lanzamiento queda obsoleta tras release

Fuentes: `index.js`, wrapper de prepare_launch y execute.before; `launch-binding.js`.

El wrapper escribe una asociación session+agent en memoria. `release` liquida el despacho durable, pero no elimina la asociación. El siguiente prepare para el mismo agente falla, o un subagent consume el despacho ya released y falla al reclamarlo. A02 reproduce la divergencia componiendo los mismos dos componentes; no es una prueba del runtime OpenCode real. En `index.js` no existe llamada a clear/consume para release. El mensaje pide liberar, pero liberar no satisface la condición en memoria.

Corrección: eliminar únicamente la asociación del despacho liberado y reconstruir/validar bindings contra estado durable tras reinicio. Exigir binding para toda delegación gobernada: actualmente, si no existe, execute.before simplemente sigue sin reclamar un despacho. Esta última ruta está confirmada estáticamente y requiere prueba de integración del plugin.

### F08 — Revisión del mismo candidato no admite evolución

Fuente: `record_review`, operation id `${executionId}:review:${candidateId}`.

A03 registra CHANGES_REQUIRED y luego intenta PASS con evidencia de ejecución ya válida para el mismo candidato. Obtiene conflicto de operation_id. Esto puede ocurrir si cambia evidencia, resolución autorizada o evaluación de un reviewer sin cambios en bytes. Congelar de nuevo los mismos bytes/contrato produce el mismo id.

Corrección: revisiones inmutables versionadas, ligadas a candidato, reviewer, evidencia y autorización efectiva. Elegir explícitamente la revisión vigente. No sobrescribir PASS anterior ni exigir cambios ficticios de archivos para crear otro id.

### F09 — Integración sin ruta de rebase/cancelación

Fuentes: `bind_pr`, `BIND_PR`, `MERGE_START`, `runMergeCandidate`.

A05 cambia solamente base_sha y recibe conflicto de idempotencia; el identificador de bind usa candidato/repo/PR, pero no base/head. La máquina también rechaza reemplazar el mismo candidato. A06 demuestra que un fallo de CI remoto después de MERGE_START impide vincular un nuevo candidato corregido y revisado porque sigue habiendo un merge en curso. No hay evento MERGE_ABORT/REVALIDATE/REBIND.

Corrección: comprobar CI antes de marcar intención de efecto y distinguir estados preflight/intento enviado/resultado incierto/observado. Rebase/rebind explícitos con invalidación de evidencia afectada. Si hay efecto remoto incierto, consultarlo antes de autorizar otro intento. Nunca arreglar esto borrando state.merge.

### F10 — Verificación aislada incompleta para proyectos reales

Fuentes: `verification-workspace.js`, `verification.js`, registro de `harness_run_verification`.

El workspace materializa archivos del candidato, no dependencias, servicios ni base de datos. Cada check usa un workspace nuevo. Un check de instalación no prepara el siguiente check porque ese workspace se destruye. A07 pasa en checkout con una dependencia local instalada y falla en candidato por módulo ausente.

Además, el default de 30 s no es configurable por check a través de la herramienta ni del hash normativo del contrato. Una suite legítima más larga puede terminar como FAIL por timeout. No se probó una espera real de 30 s porque el cableado lo establece directamente.

Corrección: entorno reproducible autorizado con preparación compartida controlada, lockfiles, fixtures/servicios y timeouts por check incluidos en el hash. Reportar fallos de infraestructura separados de fallos funcionales. Mantener aislamiento de datos/credenciales. No copiar ciegamente node_modules ni usar una orden shell libre como atajo.

### F11 — Preflight promete más de lo que comprueba

Fuentes: `readiness.js` y wiring en `index.js`.

A11 devuelve READY con remaining=0 porque buildReserve/reviewReserve son cero. El wrapper solo suministra remaining (o Infinity si falta), no un presupuesto derivado del controlador. `workspace.supported` devuelve READY constante y `reviewer.execute_declared_checks` solo comprueba existencia de agente/herramienta. No verifica entorno candidato, permisos efectivos, GitHub token/repo/branch, ni capacidad real de cerrar el ciclo.

Corrección: preflight desde contrato durable y recursos reales, con plan de capacidad para implementación, revisión y cierre. Un presupuesto desconocido no es ilimitado. Validar las capacidades críticas antes de gastar en BUILD; revalidar las volátiles cuando corresponda.

### F12 — El contrato real depende demasiado de interpretación tardía

Fuentes: `harness_freeze_candidate`, `record_candidate`, `verificationContractHash`, `story-validator.js`.

La herramienta acepta `verification_contract` aportado por el llamador y rutas de snapshot elegidas manualmente. Añade source_wu_id si falta, pero no deriva comandos del artefacto autorizado ni comprueba su hash contra un contrato efectivo de WU al registrar el candidato. `record_candidate` lo asocia a la WU activa. Un hash demuestra estabilidad de lo congelado, no que los checks cubran lo que el dueño aprobó.

La obligación de RED previa también queda en instrucciones/documento. No existe un protocolo de evidencia previo al primer cambio para obligaciones de orden. Puede descubrirse la violación al final, cuando se consumió casi todo el presupuesto.

Corrección: contrato compilado, versionado y trazable con etapas y evidencias exigibles. Detectar requisitos de proceso antes de editar. Una excepción explícita debe actualizar la política efectiva vinculada a evidencia/review, conservando la desviación; no falsificar el pasado ni alterar unilateralmente criterios funcionales.

### F13 — NO_PROGRESS no conoce cambios externos

Fuente: `turn-guard.js`, `runHarness`.

Tras dos fallos idénticos, el tercer intento se rechaza antes de ejecutar. Un cambio real de CI, red o credenciales no invalida la memoria; status/verify tampoco. A08 simula que el tercer intento ya tendría éxito y prueba que nunca se invoca. El mecanismo sí evita loops de mutaciones sin progreso, pero equipara algunos estados transitorios con una incapacidad permanente durante el turno.

Corrección: clasificación tipada transitorio/terminal, fingerprints de evidencia/revisión y reintentos acotados con backoff. Esperar CI debe ser WAITING_EXTERNAL, no una mutación fallida repetida. No reiniciar el contador indiscriminadamente ante lecturas irrelevantes.

### F14 — Evidencia de CI seleccionada de forma insuficiente

Fuente: `github-adapter.js`, `getChecks`.

Construye Map(name → conclusion) con los registros recibidos; el último nombre repetido gana sin comparar id, attempt o timestamps. A12 suministra un éxito reciente seguido de fallo anterior y selecciona el fallo. La API solo consulta una página de check-runs y no considera status contexts. Esto puede tanto bloquear con evidencia obsoleta como elegir un resultado que no corresponde al intento pertinente. No se afirma un orden real de respuesta observado en ALFRAN: el defecto es depender del orden sin verificarlo.

Corrección: identidad completa de check/proveedor/attempt, paginación, selección explícita del intento pertinente y tratamiento de pending. Agregar timeout/cancelación al adapter HTTP; actualmente fetch carece de ellos.

### F15 — verify acredita consistencia, no integridad completa

Fuentes: `event-log.js`, `validateLog`; `controller-tool.js`, `verify`.

A09 modifica el body de un evento temporal sin recalcular operation_hash y verify sigue PASS. El validador comprueba estructura/secuencia, y ambas proyecciones comparadas leen el mismo log. No verifica ese hash. Tampoco valida que un estado tenga camino de progreso o que se cumpla todo el contrato de WU.

Corrección: verificar hashes versionados al leer; definir migración de eventos legacy. Separar integrity, accounting, policy, readiness y liveness en el resultado. Un hash local no es por sí solo una firma autenticada: no prometer resistencia absoluta a alguien que puede reescribir todos los archivos.

### F16 — Recuperación costosa y dependiente del contexto

Fuentes: `session-recovery.js`, `dispatch-handoff.js`; log aportado con 303728 caracteres leídos en ocho páginas.

La recuperación exacta es preferible a adivinar identidades, pero depende de mensajes que pueden desaparecer por compaction. La captura automática de identidad ocurre en execute.after; no cierra todos los escenarios de caída durante el hijo. El reader serializa mensajes/herramientas completos y pagina por caracteres. La orden de continuar puede gastar gran parte del contexto reconstruyendo lo que pasó.

Corrección: recibo terminal durable y estructurado de cada despacho (estado de ejecución, resultado de tarea, branch/head, cambios, checks, pendientes, consumo/evidencia), capturado con APIs soportadas. Resumen verificable primero y lectura selectiva después. Distinguir siempre runtime succeeded de WU aceptada. Verificar en runtime real los eventos disponibles antes de elegir hooks.

### F17 — Configuración e instrucciones efectivas pueden divergir

Fuentes: `global-agent-provisioner.js`, `orchestrator-steps.js`, readiness, `package.json`, `docs/architecture.md`.

El provisioner conserva perfiles no administrados o editados, lo cual protege personalizaciones. Los perfiles del proyecto pueden seguir aportando instrucciones viejas; el transform actual solo migra el valor de pasos del orquestador. No hay huella integral de instrucciones efectivas en readiness. `@opencode/plugin` usa `latest`. La documentación de arquitectura aún dice que el plugin nunca hace merge mientras el runtime ya implementa governed_auto.

Corrección: manifest/fingerprint de versión de plugin, SDK y perfiles efectivos; migraciones revisables sin sobrescribir personalizaciones; mostrar incompatibilidades antes de activar una WU. Unificar documentación y prompts. La presencia de este riesgo está confirmada en código; no se verificó que el usuario tenga perfiles obsoletos.

### F18 — Pruebas de unidades se están usando como evidencia de autonomía

Fuentes: `.github/workflows`, `tests/execution/e2e-wu058.test.js`, pruebas multi-WU, merge/ownership/recovery.

CI ejecuta `npm run check` con Node 22. Las pruebas revisadas construyen eventos o usan fakes del runtime/remoto; algunas llamadas E2E operan directamente sobre project/applyEvent. Son útiles para invariantes, pero no verifican el plugin instalado, perfiles locales/globales, hooks encadenados, proveedor, pasos, compaction y proyecto real. El entorno de esta auditoría usa Node 24.19; no sustituye la matriz de runtime.

Prueba concreta de la brecha: 421 tests verdes coexisten con las 13 reproducciones del anexo. Los fixes recientes añadieron tests focalizados y no bastaron para acreditar continuidad. Esa limitación debió explicarse más claramente en los informes de cierre anteriores.

Corrección: integración del plugin completo con runtime contract fakes, pruebas de fault injection por cada frontera durable/externa, y canario real versionado en un proyecto de ensayo antes de ALFRAN. Las pruebas deben comprobar progreso y recuperabilidad, además del rechazo de acciones inválidas.

### F19 — completed no impide toda ejecución posterior

Fuentes: `applyEvent`, `COMPLETE`, `FORWARD_EXECUTION_TYPES`.

No hay una guarda general state.completed para operaciones de avance. A10, usando el camino público de diagnóstico init, completa la ejecución y luego reserva un nuevo despacho: completed=true convive con reserved. El reproductor se limita a ese camino; el análisis estático identifica la falta de guarda global que también afecta a la máquina compartida.

Corrección: terminalidad explícita. Después de completar, solo observación, auditoría o una nueva autorización/transición de reapertura diseñada para ese propósito; nunca nuevas reservas por accidente.

## Qué controles sí conviene conservar

La separación entre identidad de sesión y aceptación del trabajo; no relanzar automáticamente una ejecución ambigua; reservas conservadas ante incertidumbre; operaciones con idempotencia/revisión/fencing; eventos como fuente de reconstrucción; candidatos y receipts ligados a hashes; revisión/CI obligatorias cuando el mandato las exige; prohibición de falsificar RED histórico; y protección frente a permisos denegados son decisiones útiles.

Lo que falta es que cada estado legítimamente reparable tenga una transición soportada, que el preflight detecte imposibilidades antes de BUILD y que los controles se vuelvan a evaluar en cada frontera externa. Las reglas del negocio y del dueño deben seguir vigentes; los fallos internos del harness deben repararse sin trasladar cada paso técnico al usuario.

## Plan de reparación integral

### Entrega 1 — Garantías antes de efectos externos

Corregir F01/F02/F09/F19: gates vigentes antes de merge nuevo, recibo candidato↔Git head, recuperación/cancelación del intento de merge sin perder efectos inciertos, rebind auditado y terminalidad.

Aceptación: un nuevo bloqueo impide toda llamada remota de merge; un merge ya ocurrido puede observarse sin duplicarse; CI failure→repair→fresh candidate→review→merge tiene salida; head/base cambiados nunca heredan evidencia inválida; ningún dispatch nuevo sigue a COMPLETE.

### Entrega 2 — Un único contrato efectivo y contabilidad verificable

Corregir F03/F04/F06/F12. Compilar contrato y presupuesto al activar; versionar decisiones/resoluciones/rebase con alcance; medir consumo con origen de evidencia; preservar estimaciones históricas como tales y corregir solo con prueba; reservar tiempo de revisión/cierre.

Aceptación: el techo original y el ampliado se aplican igual; un dueño que ya autorizó una recuperación no vuelve a aprobar lo mismo; ampliación del Epic y resolución de autoridad pre-WU tienen rutas explícitas; ninguna migración borra eventos o fabrica consumo/RED/aceptación.

### Entrega 3 — Supervisor de ejecución y recuperación

Corregir F05/F07/F13/F16. Estado durable de cada dispatch y su terminal reason; reconciliar bindings con el log; continuación soportada de pausas; recibos de handoff compactos; espera externa distinta de NO_PROGRESS.

Aceptación: release permite otro prepare en el mismo proceso; reinicio no permite un subagent huérfano; agotamiento de pasos produce pausa recuperable con presupuesto coherente; un cambio externo probado habilita un reintento acotado; los reintentos no duplican launches ni consumo.

### Entrega 4 — Verificación/revisión que funcione para el proyecto

Corregir F08/F10/F11/F14/F17: entorno preparado desde lockfiles/servicios declarados, timeout por check, preflight del ciclo completo, revisión versionada, selección correcta de CI, fingerprints efectivos y documentación consistente.

Aceptación: un mismo test pasa en checkout y candidato preparado cuando sus bytes/entorno son equivalentes; una suite legítima >30 s usa su timeout aprobado; nueva evidencia permite revisar el mismo candidato; readiness no declara operable un ciclo imposible; versiones/perfiles incompatibles se detectan al inicio.

### Entrega 5 — Prueba de sistema y migración

Corregir F15/F18 y convertir las reproducciones en regresiones del comportamiento deseado. Añadir integridad de eventos compatible con versiones previas. Ejecutar un canario con varias WUs y presupuesto aprobado que incluya:

1. Implementación, GREEN, revisión, corrección y nueva revisión.
2. Fallo y posterior éxito de CI; cambio de base y recuperación.
3. Pausa de especialista, reinicio entre prepare/claim/resultado, y compactación.
4. Presupuesto cercano al límite y aprobación aplicada una sola vez.
5. Decisión de autoridad posterior, sin autorización duplicada.
6. Bloqueo nuevo durante un merge iniciado.
7. Paso a siguiente WU y cierre terminal.

Criterio de salida: corrida real sostenida de más de 30 minutos en OpenCode, dentro de un presupuesto explícito de ensayo, sin intervención humana para reparar defectos internos del harness. Medir pausas, causas, recuperación y consumo; no exigir ausencia de stops legítimos por falta de autoridad, pruebas fallidas o permiso denegado. Migrar una copia de estado real y verificar historia/contabilidad antes de aplicar en ALFRAN.

## Próximo paso recomendado

Implementar estas entregas como un plan único con regresiones compartidas, comenzando por los P0 y la contabilidad/contrato. Esta auditoría no ejecuta ese plan ni cambia políticas de ALFRAN. Los 500 segundos y la autorización retrospectiva del último log no constituyen presupuesto para un experimento ilimitado ni prueba de que ya se aplicó la recuperación en el runtime del usuario.

## Reproducción

Desde la raíz del repositorio auditado:

```sh
npm run check
node docs/audits/2026-10-08/reproduce.mjs
```

Los probes A04/A06/A12/A13 usan remoto simulado; A02 compone los componentes de memoria y durable sin levantar OpenCode; A09 altera únicamente un log temporal; A10 usa una ejecución de diagnóstico. Los demás prueban funciones/rutas públicas locales con fixtures. No se presentan como validación en vivo del entorno del usuario.
