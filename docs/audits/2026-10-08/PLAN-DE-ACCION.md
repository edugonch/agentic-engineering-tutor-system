# Plan de reparación integral del Harness

Fecha: 8 de octubre de 2026. Estado: **implementación y regresiones locales realizadas; aceptación integral pendiente**. Véase [IMPLEMENTACION.md](IMPLEMENTACION.md) para distinguir correcciones comprobadas, alcance parcial y validación real pendiente.
Base: auditoría de `main` en `f094b038f1f036a55eb6f375fcac6d15678c8792`.
Referencia: [AUDITORIA.md](AUDITORIA.md), con 19 hallazgos y 13 reproducciones aisladas.

## Resultado requerido

Una orden autorizada debe iniciar o reanudar el ciclo completo de una WU y continuar el Epic dentro del mandato y presupuesto vigentes. El controlador debe recuperarse de interrupciones internas, esperas de CI, cortes de sesión y correcciones del builder sin pedir al usuario que dirija cada transición.

La reparación termina cuando esto se demuestra en el runtime soportado de OpenCode, con evidencia durable, revisión independiente, verificación del contenido exacto y merge comprobado. Una suite unitaria verde o una herramienta nueva aislada no bastan.

Se mantienen las paradas por falta real de autorización, presupuesto agotado, riesgo de seguridad y evidencia insuficiente para cerrar. Cada parada debe indicar condición concreta, evidencia, trabajo pendiente y transición soportada para resolverla. Una aprobación ya registrada y aplicable no debe solicitarse otra vez.

## Secuencia y entregables

Cada entrega será un cambio revisable con sus regresiones. Se integrará en `main` después de cumplir sus criterios. Los componentes incompletos que dependan de entregas posteriores permanecerán desactivados explícitamente; no se anunciará continuidad completa hasta terminar E8.

| Entrega | Objetivo | Hallazgos | Dependencias |
|---|---|---|---|
| E0 | Fijar evidencia y matriz de aceptación | F18, todos como trazabilidad | Ninguna |
| E1 | Proteger efectos externos y cierre terminal | F01, F02, F09, F19 | E0 |
| E2 | Integridad y evolución del estado durable | F15; base para F06 | E0 |
| E3 | Contrato efectivo y presupuesto verificable | F03, F04, F12 | E2 |
| E4 | Recuperación de bloqueos y esperas externas | F06, F13; cierre de F09 | E1–E3 |
| E5 | Supervisor durable de sesiones y ownership | F05, F07, F16 | E3–E4 |
| E6 | Verificación reproducible, revisión y CI | F08, F10, F14; vínculo F02/F12 | E1–E3 |
| E7 | Readiness y configuración efectivas | F11, F17 | E3, E5–E6 |
| E8 | Migración, prueba real sostenida y cierre | F18 y aceptación de F01–F19 | Todas |

Orden de ejecución propuesto: E0 → E1 → E2 → E3 → E4 → E5 → E6 → E7 → E8. Las dependencias permiten dividir PRs sin mezclar cambios inseparables. Antes de cada entrega se contrastará `main` con la base auditada para no sobrescribir correcciones posteriores.

## E0 — Evidencia y contrato de aceptación

1. Conservar el reproductor y resultados de la auditoría como evidencia histórica del defecto.
2. Convertir A01–A13 en regresiones que exijan el comportamiento correcto. No reutilizar como aceptación las aserciones que hoy confirman el comportamiento defectuoso.
3. Añadir matriz de transiciones para cada estado/bloqueo: entradas permitidas, efectos, evidencia requerida, idempotencia, recuperación y estado terminal.
4. Crear fixtures de ejecución interrumpida y adaptadores controlables para inyectar fallos, reinicios, duplicados y cambios concurrentes.
5. Registrar versión del plugin, SDK, OpenCode, perfiles efectivos y comandos de verificación en los resultados.

**Aceptación:** cada hallazgo tiene una prueba prevista y una entrega responsable; las regresiones nuevas pertinentes fallan contra la base auditada. Los casos que requieren runtime real quedan identificados como pendientes, sin sustituirlos por mocks.

## E1 — Merge seguro y terminalidad

Fuentes principales: `merge.js`, `state.js`, `candidate.js`, `candidate-registry.js`, `github-adapter.js` y `controller-tool.js`, dentro de `src/execution/`.

1. Revalidar bloqueo, mandato, revisión, verificación, identidad del candidato y estado vigente antes de cada nuevo efecto remoto de merge, incluidos reintentos. Usar revisión/fencing para impedir que una autorización local obsoleta produzca ese efecto.
2. Separar la observación de un merge ya sucedido de la autorización para realizarlo. Una interrupción después del efecto remoto debe poder recuperarse sin repetirlo.
3. Vincular candidato materializado a árbol Git completo, base y head remoto. Comprobar el contenido mediante una fuente verificable del repositorio; no confiar en un SHA aportado por el modelo. Una selección parcial de archivos no acredita por sí sola el árbol completo.
4. Modelar intentos de integración con identidad propia y transiciones explícitas para espera, invalidación, cancelación y nuevo intento. Un fallo de CI o movimiento de base no debe encerrar la ejecución en `STARTED`.
5. Requerir nueva evidencia cuando cambie el contenido; permitir revalidación documentada cuando cambie solo la asociación remota y las garantías aplicables sigan satisfechas.
6. Impedir nuevas reservas, despachos y mutaciones de avance después de `completed`. Mantener lectura, verificación y recuperación contable explícitamente permitida, sin reabrir trabajo tácitamente.

**Aceptación:** A04/A05/A06/A10/A13 convertidas a regresiones; un bloqueo nuevo impide el merge; un head con bytes distintos se rechaza; un timeout tras merge recupera exactamente un efecto; cambiar base/head invalida la evidencia correspondiente; `completed` no permite trabajo nuevo. Probar también cambios concurrentes entre lectura y efecto.

## E2 — Estado durable íntegro y versionado

Fuentes: `event-log.js`, `execution.js`, `state.js`, proyectores y verificadores.

1. Verificar el hash de cada operación con su algoritmo y serialización definidos; detectar alteraciones antes de autorizar nuevas mutaciones.
2. Versionar eventos/esquemas y especificar compatibilidad de lectura. Separar claramente eventos históricos válidos de registros que no puedan verificarse.
3. Preparar migración con lectura y diagnóstico previos, copia consistente, validación y aplicación atómica cuando corresponda. Preservar historial e identidades; registrar cambios de estado mediante eventos explícitos.
4. Definir qué operaciones de diagnóstico siguen disponibles si la integridad falla. No autorreparar evidencia corrupta inventando hashes nuevos.

**Aceptación:** A09 rechaza un cuerpo alterado; estado intacto antiguo sigue siendo legible; una migración repetida no duplica eventos; una interrupción deja un estado recuperable. El rollback se prueba con las versiones de esquema introducidas.

## E3 — Contrato ejecutable y contabilidad

Fuentes: activación de WU en `controller-tool.js`, `verification-contract.js`, `wu-budget.js`, `execution.js`, `state.js` y artefactos de conocimiento.

1. Compilar al activar la WU un contrato versionado desde la fuente aprobada: alcance, límite original, criterios, obligaciones de proceso, verificación y política de cierre. Fijar identidad y hash; rechazar ambigüedades antes del despacho.
2. Hacer que freeze, builder, reviewer y verificación consuman ese mismo contrato. Las modificaciones autorizadas crean una versión efectiva trazable; el modelo no puede sustituirlo mediante argumentos libres.
3. Definir la unidad de presupuesto. Propuesta: conservar segundos de tiempo activo por worker como cargo, sumar actividad concurrente y registrar espera externa separadamente; contrastar esta semántica con contratos existentes antes de aplicarla. No reinterpretar retrospectivamente límites aprobados.
4. Capturar tiempos e identidad desde el runtime confiable. Distinguir reserva, consumo medido, estimación conservadora y consumo desconocido. Evitar doble cargo entre fase y despacho.
5. Liberar saldo no consumido cuando haya evidencia suficiente. Si falta medición, mantener el fallback conservador identificado como tal. Cualquier corrección histórica exige evidencia y evento compensatorio; nunca reescribir cargos por intuición.
6. Distribuir el presupuesto disponible entre implementación, verificación, revisión y cierre según el contrato y mediciones disponibles. Detectar inviabilidad antes de lanzar una fase; no inventar una ampliación.
7. Detectar obligaciones como RED antes de implementar. Una excepción aprobada debe modificar explícitamente la obligación efectiva sin falsear la historia.

**Aceptación:** A01 ya no permite exceder el límite original; lanzamiento breve con medición no consume toda la reserva; duplicados no cobran dos veces; tiempo desconocido no se convierte en cero; cambios de contrato invalidan evidencia incompatible. Presupuestos histórico, ampliado y agotado tienen pruebas separadas.

## E4 — Recuperación completa y esperas

Fuentes: constantes de bloqueos, `state.js`, `controller-tool.js`, guardas de no progreso y decisiones aprobadas.

1. Implementar la matriz de recuperación de E0 para autoridad, presupuesto, evidencia, tooling, seguridad, no progreso y cambios de mandato/base. Cada transición exige resolver la causa concreta.
2. Consumir decisiones aprobadas por identidad, hash, alcance y bloqueo/version exactos. Resolver una vez y devolver el resultado idempotente en reintentos. Una aprobación para una WU no autoriza otra ni elimina controles funcionales.
3. Representar `WAITING_EXTERNAL` para CI, red temporal y recursos transitorios. Registrar próximo intento, demora acotada y condición de salida; evitar que cada espera se convierta en una excepción que exige intervención humana.
4. Basar no progreso en estado y evidencia observados, no solo en repetir argumentos. Un cambio externo verificable permite nuevo intento; repetir indefinidamente sin cambios sigue deteniéndose con diagnóstico.
5. Distinguir pausa recuperable, decisión requerida y fallo terminal. Exponer una siguiente acción soportada para cada pausa recuperable.

**Aceptación:** autorización aplicable libera exactamente el bloqueo correspondiente sin pedirla otra vez; aprobación ajena o desactualizada se rechaza; A08 permite recuperación al cambiar CI; fallo idéntico sin cambios no genera bucle; backoff sobrevive reinicio y respeta presupuesto/mandato.

## E5 — Continuación y posesión durable

Fuentes: `index.js`, `launch-binding.js`, `continuation-driver.js`, recuperación de sesiones, `dispatch-handoff.js` y perfiles de agentes.

1. Verificar primero las capacidades reales de la versión soportada de OpenCode: crear/continuar sesión, observar terminalidad y capturar identidad. No promover el probe experimental como supervisor productivo sin esa prueba.
2. Persistir la asociación execution → WU → dispatch → sesión y su intento antes de depender del contexto conversacional. Resolver explícitamente la ventana entre lanzamiento remoto y captura de identidad.
3. Hacer claim/launch/release idempotentes. Limpiar asociaciones específicas al liberar; rechazar un lanzamiento especializado sin claim válido; probar toma de posesión desde Build al orquestador.
4. Definir resultados estructurados `completed`, `yielded`, `failed` y `blocked`, con evidencia y trabajo pendiente. Un terminal runtime exitoso no equivale a WU completada.
5. Sustituir los cortes de pasos predeterminados por continuación gobernada por presupuesto, progreso y salud del runtime. Si existe un límite explícito del usuario/proveedor, respetarlo y producir un yield recuperable, no un cierre ficticio.
6. Implementar supervisor durable que reanude la sesión o cree una continuación enlazada cuando corresponda, evitando despachos duplicados. Reanudar tras compaction/reinicio sin reconstruir identidad desde texto perdido.
7. Persistir handoff compacto estructurado y referencias a evidencia extensa. Conservar acceso paginado al original para auditoría; no exigir leer cientos de miles de caracteres para descubrir la siguiente acción.

**Aceptación:** A02 pasa; release/prepare no reutiliza una asociación vieja; reinicio en cada frontera no duplica builder; compaction conserva recuperabilidad; un especialista que cede continúa sin nueva orden; resultado parcial no autoriza `record_finish` como éxito funcional. La toma de posesión se prueba con el plugin real.

## E6 — Verificación, revisión y CI utilizables

Fuentes: `verification.js`, `verification-contract.js`, receipts, `record_review`, `github-adapter.js` y binding de PR.

1. Preparar un entorno reproducible por candidato: dependencias fijadas, servicios y configuración declarados. Compartir preparación dentro de la ejecución de verificación cuando el contrato lo requiera, manteniendo aislamiento entre candidatos.
2. Hacer timeout parte del contrato efectivo, acotado por presupuesto y capacidades reales. Eliminar el límite público fijo de 30 segundos como supuesto universal.
3. Persistir evidencia suficiente de comandos, entorno, resultados y logs referenciados para revisión; preservar procedencia e integridad de receipts.
4. Identificar revisiones por intento y evidencia. Permitir una nueva revisión del mismo candidato sin conflicto artificial; conservar dictámenes anteriores y exigir independencia efectiva del reviewer.
5. Consultar todos los checks/status relevantes con paginación e identidad de proveedor/app/contexto/intento. Seleccionar el intento vigente del head exacto, no el último nombre recibido. Aplicar la política de checks requeridos de forma explícita.
6. Añadir timeout/cancelación de HTTP y distinguir errores transitorios de rechazos permanentes. Las mutaciones ambiguas se observan antes de reintentarlas.

**Aceptación:** A03/A07/A12 pasan; proyecto con dependencias verifica desde candidato limpio; timeout contractual mayor de 30 s funciona dentro del presupuesto; CHANGES_REQUIRED → nueva evidencia → PASS conserva historial; checks homónimos/antiguos y más de una página no dan falsos resultados; CI de otro head no sirve para merge.

## E7 — Preflight y configuración efectiva

Fuentes: `readiness.js`, `index.js`, provisionador de agentes, perfiles, `package.json`, CI y documentación.

1. Calcular readiness desde contrato y estado durables: presupuesto real, permisos efectivos, agentes, preparación de workspace, servicios, capacidades SDK y acceso necesario para el cierre solicitado.
2. Con cero presupuesto para trabajo pendiente, devolver no preparado con causa precisa. Eliminar defaults optimistas como infinito o soporte constante cuando falta evidencia.
3. Fijar y probar versiones compatibles del SDK/OpenCode. Registrar fingerprints de plugin, perfiles globales/de proyecto y configuración efectiva; detectar sombras o perfiles obsoletos antes de ejecutar.
4. Preservar personalizaciones del usuario y mostrar diferencias incompatibles. No sobrescribirlas silenciosamente ni afirmar que instalar el plugin actualiza todo el entorno.
5. Actualizar documentación y prompts para reflejar transiciones, continuación y merge gobernado realmente soportados.

**Aceptación:** A11 pasa; un preflight positivo permite completar la preparación real; falta de permiso/servicio/dependencia se detecta antes del builder; perfil sombreado se identifica; versiones usadas quedan reproducibles en CI y diagnóstico.

## E8 — Migración y demostración real

### Antes de tocar ALFRAN

1. Ejecutar las regresiones y la matriz de transiciones completas sobre el controlador público y el wiring del plugin, además de pruebas unitarias.
2. Probar una copia anonimizada o fixture fiel del estado histórico: reservas, decisiones, bloqueos, sesiones y merge interrumpido. No modificar la ejecución productiva para fabricar una prueba.
3. Realizar un canary real con OpenCode en repositorio controlado y mandato/presupuesto adecuados: varias WUs, revisión que solicita cambios, corrección, CI pendiente/fallido/recuperado, reinicio, compaction y merge verificado. Incluir más de 30 minutos de trabajo real; dormir 30 minutos no acredita continuidad.
4. Si ese runtime no está disponible aquí, entregar el runner y protocolo reproducibles y marcar la validación real pendiente. No anunciar reparación completa basándose solo en simulaciones.

### Aplicación al estado existente

1. Leer estado vivo, `verify`, versión efectiva y decisiones. La revisión 49 y los 500 s de WU063 proceden de los logs aportados: no asumir que sigan siendo actuales.
2. Capturar copia consistente y ejecutar diagnóstico/migración en seco. Mostrar diferencias de proyección, presupuesto, bloqueos e identidades antes de aplicar.
3. Aplicar únicamente la migración necesaria y las transiciones ya autorizadas. Conservar rama parcial, sesiones, historial y cargos. No crear otro builder mientras el despacho existente tenga resultado ambiguo.
4. Si sigue pendiente el bloqueo de autoridad de WU063, resolverlo mediante la decisión aprobada `WU063-RETROSPECTIVE-VALIDATION-OWNER-AUTHORIZATION`, comprobando integridad, alcance y vínculo al bloqueo vigente. PR #33 ya añadió una transición: verificar su comportamiento real antes de duplicarla.
5. Continuar WU063 con validación retrospectiva transparente: corregir las tres pruebas reportadas si siguen fallando; demostrar invariantes contra baseline/mutaciones; GREEN completo; revisión independiente; verificación exacta; PR; CI del head exacto; merge gobernado; MERGE_VERIFY; complete_wu.
6. Conservar la declaración aprobada: “TDD ordering deviation: implementation preceded the required RED execution. No historical RED evidence exists. Retrospective validation was explicitly authorized by the owner.”
7. Respetar el presupuesto vivo autorizado. Si permanece en 500 s y no alcanza, emitir un único bloqueo de presupuesto con desglose del trabajo pendiente. Este plan no autoriza ampliación ni avance a WU064 antes de completar WU063.

### Reversión

Antes de emitir eventos nuevos puede revertirse el binario si el esquema lo permite. Después, una versión antigua solo puede usarse si entiende esos eventos: disponer de lector compatible o reparación hacia adelante. No borrar eventos ni restaurar una copia antigua sobre una ejecución que pudo producir efectos remotos; primero reconciliar esos efectos para impedir duplicados.

## Evidencia exigida para cerrar

| Garantía | Evidencia mínima |
|---|---|
| Los 19 hallazgos están tratados | Matriz F01–F19 con commit, prueba, resultado y limitación residual |
| No se integra contenido distinto al revisado | Recibo de candidato/árbol/head y regresiones de divergencia/concurrencia |
| El presupuesto se respeta y explica | Ledger trazable, medición/fallback diferenciados, ausencia de doble cargo |
| Una interrupción no requiere dirigir manualmente al agente | Trazas reales de yield, reinicio, recuperación, review/corrección y CI |
| Las decisiones aprobadas son utilizables | Resolución idempotente y acotada del bloqueo, conservando historial |
| La configuración instalada corresponde a lo probado | Versiones y fingerprints efectivos del canary y del despliegue |
| Epic/WU solo cierran con evidencia suficiente | GREEN, revisión independiente, exact-head CI y merge verificado |

Se registrarán intervenciones humanas y su causa en el canary. El objetivo es **cero intervenciones por defectos internos de continuidad**; las decisiones nuevas de alcance, seguridad o presupuesto siguen requiriendo autoridad válida. También se medirán reintentos, duplicados, tiempo de espera y costo estimado frente al medido para detectar regresiones.

## Primer paso al ejecutar el plan

Actualizar la comparación con `main`, preparar E0 y reparar E1 con sus regresiones. Después continuar las entregas en orden, integrando cada unidad verificada. No empezar modificando manualmente el bloqueo vivo: eso no corrige las causas que hacen reaparecer el problema.
