# Auditoría: escalamiento innecesario al dueño y recuperación de proceso

Fecha: 9 de octubre de 2026. Baseline remoto `main`: `6cca3cfc22494678e3f69bdb4b2ef691f5812e05`. Árbol local auditado idéntico: `370ee351901d96d5d70603a4555b40b394944d27`.

## Conclusión

El problema no es únicamente que el modelo «pregunte demasiado». La combinación de clasificación libre de bloqueos, obligaciones de proceso no estructuradas y resoluciones limitadas a un bloqueo/WU convierte errores de ejecución en nuevas decisiones del dueño. El runtime conserva muy bien la parada una vez registrada, pero ofrece menos mecanismos para prevenir el error o conducir su reparación técnica.

El caso WU066 es coherente con esa implementación: el dueño resolvió el estado inicial de los SKU; el builder informó otra desviación RED; el orquestador la clasificó como `BLOCKED_AUTHORITY`; a partir de ahí el controlador exige otra resolución exacta. La excepción de WU063 no constituye una autorización para WU066. La solución debe introducir una política general explícita de recuperación, no falsificar que la excepción anterior ya tenía ese alcance.

No se modificó código de producción ni el servicio OpenCode. El registro WU066/revisión 442 procede del transcript del usuario; no se inspeccionaron directamente su ejecución durable, PR #168 o contratos de ALFRAN. Esta auditoría confirma mecanismos del Harness, no el resultado funcional del importador.

## Hallazgos priorizados

### H1 — Alta: clasificación libre, recuperación estrecha y ausencia de política general

**Fuentes:** `src/execution/controller-tool.js:562,603`; `src/execution/state.js:692,698`; `src/project-knowledge.js:822`; `src/execution/constants.js`; `templates/.opencode/agents/harness-orchestrator.md:77–79,152`.

`block` recibe clase y razón textual. No exige identificar qué decisión falta, qué regla delega o reserva esa decisión, ni por qué la reparación cambiaría alcance/autoridad. Acepta que una desviación RED sea `BLOCKED_AUTHORITY`. `AUTHORITY_RESOLVE` exige ejecución, mandato, WU y revisión exacta del bloqueo, además de procedencia de una decisión aprobada. No existe una política de recuperación de proceso de alcance Epic ni una transición para corregir de forma auditada una clasificación errónea.

**Reproducción A1:** la herramienta pública acepta un bloqueo descrito exclusivamente como «implementación antes de RED». `clear_blocker` rechaza la recuperación técnica y remite a la decisión aprobada exacta.

**Efecto:** cada WU puede volver a pedir la misma autorización. Una mala clasificación adquiere fuerza de bloqueo terminal. `supervisor.js:56` deja de programar continuación al encontrar cualquier blocker; esto amplifica el problema, aunque no sería correcto ignorar todos los bloqueos.

**Reparación propuesta:** política de recuperación con alcance explícito y procedencia del dueño, categoría de desviación de proceso, evidencia requerida y transición auditable de reparación/reclasificación. Exigir motivo estructurado para decisiones de dueño. Preservar decisiones auténticas de producto, seguridad, alcance y permisos.

### H2 — Alta: prevención de TDD débil; exigencia posterior dependiente del modelo

**Fuentes:** `src/execution/wu-contract.js:23`; `src/execution/state.js:627,646`; `src/execution/controller-tool.js:493–540`; `templates/.opencode/agents/harness-builder.md:12–23`.

`process_obligations` se copia sin validar tipo ni vocabulario. No hay eventos específicos que vinculen una ejecución RED, su baseline, la implementación y GREEN. El prompt general del builder pide pruebas focalizadas, pero su sección anterior a los cambios no establece un procedimiento condicional concreto para un contrato TDD. El contexto sí transmite las obligaciones: no se trata de que siempre se pierdan.

Los controles de review verifican hashes, receipts y cobertura de checks declarados. No verifican por sí mismos el orden RED/implementación. Esa evaluación queda en el modelo/reviewer.

**Reproducción A4:** el compilador acepta tanto un string como un objeto arbitrario en las obligaciones. **A5:** el reducer permite registrar review PASS con cobertura de checks sin receipt de orden RED, aunque la WU declare esa obligación. A5 usa entradas sintéticas del reducer; NO demuestra un bypass de las comprobaciones públicas de receipts, CI o merge.

**Efecto:** la prevención es blanda y la consecuencia posterior es una parada rígida. Un fallo por módulo ausente después de borrar una implementación tampoco demuestra por sí solo las invariantes del negocio.

**Reparación propuesta:** tipar las obligaciones y suministrar un procedimiento de preimplementación. Si se necesita garantía ejecutable del orden, diseñar evidencia ligada a baseline/árbol/ejecución, no comprobar solo palabras en el handoff. La recuperación retrospectiva debe requerir baseline o mutaciones relevantes, restauración a GREEN y revisión independiente; nunca inventar un RED previo.

### H3 — Alta: el contexto automático transmite solo la última resolución

**Fuentes:** `src/execution/worker-budget.js:74`; `index.js:201–205`; `src/execution/state.js:707–710`.

El ledger acumula `authority_resolutions[wu_id]`, pero el contexto del especialista usa `.at(-1)`. Una resolución posterior sobre otro tema oculta las anteriores en esa inyección automática. No las elimina del ledger y el orquestador puede incluirlas manualmente, pero la continuidad depende de que lo haga.

**Reproducción A2:** guardar dos resoluciones en el mismo WU produce un ledger con dos elementos; el contexto real generado por `guard.inspect` contiene únicamente la segunda.

**Efecto:** builder/reviewer pueden reabrir asuntos resueltos o no recibir todas las condiciones aplicables. No se afirma que este sea el detonante concreto de WU066: allí la excepción retrospectiva citada era de otro WU.

**Reparación propuesta:** enviar todas las decisiones aplicables no sustituidas, con alcance, identificadores y precedencia explícita. Añadir pruebas con decisiones independientes, sustituciones y recuperación de sesión. No mezclar automáticamente decisiones de WUs distintos.

### H4 — Alta: la espera de CI vence antes de observar el remoto

**Fuentes:** `src/execution/external-wait.js:33–39`; `src/execution/state.js`, evento `EXTERNAL_WAIT_END`; `src/execution/supervisor.js:56`.

La rama de deadline termina la espera con `EXPIRED` y registra `BLOCKED_EXTERNAL_FACT` antes de ejecutar el callback que observa la operación remota. Una vez bloqueada la ejecución, el supervisor se desarma.

**Reproducción A3:** se suministró un observador que devolvería éxito actual; al vencer la espera, el contador de observaciones fue cero y el resultado fue `BLOCKED_EXTERNAL_FACT`.

**Efecto:** una demora o un despertar tardío puede exigir intervención aunque el CI ya haya terminado. No demuestra que todo deadline deba eliminarse.

**Reparación propuesta:** distinguir observar de mutar. Al vencer, hacer una observación autenticada y acotada del head/PR exactos antes de clasificar el bloqueo, con backoff y transición de recuperación. Nunca inferir éxito por el tiempo transcurrido ni efectuar un merge sin sus controles.

### H5 — Media: correcciones técnicas dependen de un nuevo origen APPROVED

**Fuentes:** `src/execution/controller-tool.js:369`; `src/execution/contract-correction.js:12,25,36`; `templates/.opencode/agents/harness-reviewer.md:18–24`.

El reviewer solo ejecuta checks declarados. Una corrección del contrato exige un origen aprobado; un bloqueo de autoridad impide esa corrección y las obligaciones de proceso se conservan intactas. Esto es correcto para impedir una dispensa oculta, pero no existe una categoría explícita para adaptar mecánicamente comandos/configuración dentro de una autoridad técnica ya delegada, ni para añadir la evidencia de una recuperación general.

**Efecto potencial:** un ajuste de workspace, runner o comprobación puede terminar como otra aprobación si no existe un artefacto aprobado aplicable. No significa que toda normalización requiera consultar: el prompt permite reutilizar aprobación existente.

**Reparación propuesta:** separar adaptación mecánica, ampliación de comprobaciones y cambio de criterios de aceptación. Las dos primeras pueden delegarse de forma expresa conservando criterios, procedencia y nuevas verificaciones; la última requiere la autoridad correspondiente. No debilitar el guard actual como atajo.

### H6 — Media: instrucciones de arquitectura/research escalan demasiado ampliamente

**Fuentes:** `templates/.opencode/agents/harness-orchestrator.md:86,184`; `templates/.opencode/skills/architecture-decision/SKILL.md:21,26`.

Las instrucciones dicen presentar cualquier recomendación de research al dueño y escalar desacuerdo/falta de evidencia después de un único challenge. Un spike con cambios exige una WU aprobada. Aunque otras instrucciones permiten elecciones reversibles convencionales, estas cláusulas no distinguen suficientemente una nueva decisión de producto de resolver una duda técnica dentro de una WU ya autorizada.

**Efecto potencial:** dudas sobre una API, un test diagnóstico o una objeción técnica reparable pueden terminar en consulta o propuesta de WU, en tensión con la secuencia congelada y la reparación dentro del scope. Hallazgo estático de diseño; no se atribuye una ejecución concreta no observada.

**Reparación propuesta:** clasificar la decisión por consecuencia y autoridad existente; permitir investigación/experimentos acotados dentro de la WU cuando ya estén autorizados. Escalar el trade-off que requiere al dueño, no el desacuerdo técnico en sí.

### H7 — Media: cobertura de pruebas orientada a controles aislados, no al incidente completo

**Fuentes:** `tests/execution/authority-resolution.test.js`; `tests/execution/contract-correction.test.js`; `tests/plugin-wiring.test.js`; `tests/architecture-guidance.test.js`.

Hay pruebas valiosas de identidad, resolución exacta, conservación de condiciones y rechazo de alteraciones. El fixture de authority-resolution construye precisamente la ruta «RED omitido → BLOCKED_AUTHORITY → aprobación individual». Algunas pruebas de instrucciones verifican la presencia de frases. No se encontró un escenario integral que pruebe recuperación de proceso previamente delegada a través de varias WUs ni acumulación de varias resoluciones en el contexto de un especialista.

**Efecto:** la suite puede estar GREEN y la experiencia seguir pidiendo autorizaciones repetitivas. Los checks existentes no certifican autonomía de extremo a extremo con un proveedor real.

**Reparación propuesta:** añadir regresiones del incidente completo, incluidas pruebas negativas: una recuperación técnica no debe resolver decisiones de publicación, importar SKU fuera del scope, dispensar tests ni falsificar historia.

## Controles que deben conservarse

- La decisión de importar 73 SKU y reportar los 15 extras es autoridad de negocio; no inferir aprobación para ampliar el catálogo.
- No convertir pruebas fallidas, runtime `succeeded` o evidencia RED retrospectiva en aceptación histórica.
- Mantener identidad de dispatch, evidencia exacta del candidato, review independiente, CI y política de merge.
- No reutilizar la excepción de WU063 como si autorizara automáticamente WU066.
- No resolver todo mediante `clear_blocker` permisivo ni hacer que el supervisor ignore indiscriminadamente bloqueos.
- El cambio de tiempos de PR #40 no resuelve estos hallazgos de proceso; su migración es independiente.

## Plan de corrección recomendado

1. Definir una política general de recuperación de proceso, con alcance y condiciones explícitos. El dueño puede delegarla una vez; aplicarla después no debe requerir aprobación por WU.
2. Añadir transiciones durables para registrar desviación, plan de reparación, evidencia y resolución. Clasificar separadamente autoridad real y reparación técnica; migrar el bloqueo existente sin editar el log ni repetir implementación.
3. Corregir el contexto para incluir todas las resoluciones aplicables y reforzar la secuencia del builder antes de implementar.
4. Integrar evidencia de proceso/recuperación con la revisión del candidato; conservar la exigencia de GREEN y revisión independiente.
5. Corregir observación/recuperación de CI y delimitar las reglas de escalamiento técnico en prompts.
6. Probar WU066 de forma aislada y después un canary real: recuperación sobre PR preservada, aceptación verificable y paso al siguiente WU autorizado sin una nueva pregunta de proceso.

## Verificación y reproducción

`node docs/audits/2026-10-09/process-authority/reproduce.mjs` ejecuta cinco probes con imports del código real y directorios temporales. `results.json` conserva las observaciones. Las pruebas usan datos sintéticos y no operan sobre ALFRAN, GitHub ni el servicio local del usuario.

`npm run check`: validación del paquete y 486 tests PASS sobre el baseline. Los probes de auditoría confirman comportamientos problemáticos; que terminen correctamente significa que la reproducción coincidió con lo observado, no que el defecto esté corregido.

Los únicos archivos creados por esta auditoría son este informe, el reproductor y sus resultados. No se aplicó un fix ni se integró código de comportamiento.
