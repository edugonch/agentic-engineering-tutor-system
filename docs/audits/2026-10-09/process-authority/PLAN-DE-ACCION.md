# Plan de acción: recuperación autónoma y pruebas de continuidad

Estado: propuesto para ejecución; este documento no aplica cambios ni modifica autorizaciones de ALFRAN. Baseline auditado: `main` en `6cca3cf`; 486 tests existentes PASS. Base: `AUDITORIA.md`, hallazgos H1–H7 y reproducciones A1–A5.

## Resultado esperado

Una instrucción vigente de completar el Epic debe permitir resolver fallos técnicos dentro del alcance delegado, conservar la evidencia y continuar. Las consultas al dueño deben corresponder a decisiones reales que el mandato no delega. El éxito se mide por escenarios completos y controles conservados, no por aumentar el número de tests.

La solución cubre contexto, clasificación de bloqueos, recuperación de proceso, evidencia TDD, correcciones técnicas y esperas externas. No elimina controles de producto, permisos, alcance, revisión independiente, CI, merge o presupuesto explícito del Epic. No impone TDD a contratos que no lo requieren.

## Secuencia de implementación

### 1. Conservar todas las decisiones aplicables y fijar regresiones — H3, H7

**Código:** `worker-budget.js`, hook de contexto en `index.js`, consultas del controlador y tests de wiring.

- Reemplazar la selección `.at(-1)` por un conjunto de resoluciones aplicables al WU y políticas de alcance Epic que realmente le correspondan.
- Identificar cada resolución por fuente/revisión, alcance y condiciones. Mantener decisiones independientes; una posterior no sustituye otra automáticamente.
- Dar soporte explícito a sustituciones cuando existan y detectar conflictos reales. No resolverlos por orden cronológico solamente.
- Si el contexto requiere paginación, incluir un índice completo y acceso determinista a cada condición; no truncar silenciosamente ni afirmar que se suministró todo.
- Convertir A2 en una regresión del contexto real del builder y reviewer. Conservar los reproductores originales como evidencia del baseline.

**Salida:** tras reiniciar o compactar una sesión, las decisiones de publicación y recuperación siguen disponibles juntas, sin mezclar WUs.

### 2. Política general y transición de recuperación de proceso — H1

**Código:** vocabulario de eventos, reducer, admisión del controlador, herramientas, conocimiento de proyecto y `next_action`.

- Definir una política versionada que delegue recuperación de desviaciones de proceso. Debe expresar alcance, tipos de desviación, evidencia exigida y límites; no reutilizar una excepción de otra WU como autorización general.
- Registrar la política a partir de autoridad ya concedida con ese alcance. Una vez adoptada, sus usos posteriores no vuelven a preguntar al dueño. La aprobación de un plan técnico por sí sola no falsifica la autoridad durable de un proyecto distinto.
- Para nuevos bloqueos de autoridad, exigir campos que identifiquen la decisión faltante, fuente aplicable, consecuencia y motivo por el que no está delegada. No decidir la categoría mediante búsqueda de palabras como «RED».
- Introducir una ruta durable de recuperación: desviación observada → reparación autorizada en curso → evidencia obtenida → evaluación independiente. Los nombres de eventos/API se definirán durante la implementación.
- Para bloqueos antiguos mal clasificados, añadir una transición específica que vincule bloqueo exacto, política aplicable y plan de reparación. Conservar el evento original; no abrir `clear_blocker` a cualquier clase.
- La transición permite trabajar en la reparación, pero no equivale a aceptación. Mientras falte evidencia, impedir cierre/merge por esa ruta.
- Hacer que supervisor y `next_action` entiendan el trabajo recuperable pendiente sin saltarse un bloqueo auténtico.

**Salida:** una omisión RED cubierta por la política deja de requerir una autorización por WU. Un cambio de publicación, permisos o scope sigue solicitando la decisión necesaria.

### 3. Prevención y evidencia verificable de proceso — H2

**Código:** `wu-contract.js`, runner/receipts, registros de candidato/review, prompts de builder y reviewer.

- Tipar obligaciones nuevas de proceso y sus rutas de evidencia. Separar criterios funcionales de obligaciones históricas y de recuperación.
- Preservar replay de contratos/eventos antiguos. Normalizar obligaciones conocidas; conservar las desconocidas como restricciones pendientes de interpretación, sin descartarlas ni volver ilegible el historial.
- Cuando se requiera TDD, el builder debe preparar el test y registrar su ejecución sobre el baseline antes de implementar el comportamiento.
- Vincular evidencia a ejecución, WU, comando, resultado y árbol/baseline observado. Un timestamp escrito por el agente no prueba el orden; no prometer reconstruir historia que el runtime no observó.
- Para desviaciones ya ocurridas: preservar la implementación, registrar la desviación y ejecutar baseline cuando sea viable y/o mutaciones focalizadas que demuestren las invariantes, restaurar cambios y llegar a GREEN.
- No aceptar como demostración funcional suficiente una eliminación posterior de archivos que solo produce un error de módulo ausente. Un error de módulo puede formar parte de TDD auténtico, pero no convierte una secuencia retrospectiva en historia previa.
- Vincular la evaluación independiente de esa evidencia al candidato exacto. Rechazar receipts ajenos, obsoletos o incompletos y cualquier cierre con pruebas fallidas.

**Salida:** el procedimiento previene la omisión y permite reparar transparentemente cuando ocurra, sin fabricar RED ni dispensar resultados funcionales.

### 4. Observar CI y recuperar esperas de forma autónoma — H4

**Código:** `external-wait.js`, supervisor, adaptador remoto y ruta de merge.

- Separar una observación remota de solo lectura de la operación que puede ejecutar un merge. No reutilizar como observador el callback actual si tiene efectos secundarios.
- Al vencer la espera, consultar de forma acotada y autenticada la PR, el head y los checks exactos antes de decidir el resultado.
- CI exitoso permite seguir por el merge gobernado, que revalida sus condiciones; fallo dirige a diagnóstico concreto; head cambiado invalida la evidencia correspondiente.
- Pendiente/servicio inaccesible conserva una espera tipada con backoff y política finita de recuperación. No crear bucles infinitos ni convertir timeout en éxito.
- Ofrecer recuperación soportada de bloqueos históricos por deadline usando observación nueva, con registro de procedencia y sin borrar el bloqueo original.
- Reinicios y despertares duplicados deben reconciliar efectos remotos ambiguos; nunca repetir un merge a ciegas.

**Salida:** el plazo vencido por sí solo no obliga al dueño a consultar GitHub para que el agente pueda continuar.

### 5. Delegación técnica y coherencia de instrucciones — H5, H6

**Código:** corrección del contrato, perfiles administrados, skill de arquitectura y guía operativa.

- Diferenciar adaptación mecánica de comandos, adición de comprobaciones y cambio de criterios funcionales.
- Permitir las dos primeras cuando la política aplicable las delegue; conservar procedencia, cobertura y revalidación. Una equivalencia semántica no se demuestra solo porque los IDs de checks coincidan.
- Mantener control de cambios que eliminen cobertura, alteren entorno/permisos o modifiquen aceptación.
- Permitir diagnósticos, investigación acotada y reparación de objeciones técnicas dentro de la WU autorizada. El desacuerdo del reviewer no equivale automáticamente a una decisión de negocio.
- Sustituir instrucciones contradictorias de «preguntar por cualquier recomendación» por criterios concretos de escalamiento.
- Verificar provisión y recarga de perfiles sin sobrescribir personalizaciones. Mostrar si el runtime aún carga un perfil antiguo.

**Salida:** cambios técnicos delegados avanzan; decisiones nuevas de negocio, scope o seguridad se presentan con la pregunta mínima y su consecuencia.

### 6. Integración completa y prueba real — H7

- Integrar los incrementos en PRs revisables, con CI del head exacto. Orden recomendado: contexto; política/recuperación; evidencia; CI; delegación técnica y cobertura final. No publicar una ruta de recuperación que permita aceptación antes de tener sus guards y pruebas.
- Ejecutar una simulación integral basada en WU066 con fuentes sintéticas. Conservar PR/candidato, detectar la desviación, validar retrospectivamente, corregir hasta GREEN, obtener review y verificar merge; después avanzar solo al siguiente WU declarado.
- Tras actualización y reinicio del plugin, comprobar la versión y capacidades efectivamente cargadas.
- En el canary real, leer el estado vigente: revisión 442 y PR #168 son el último dato del transcript, no valores a fijar en código. Si el trabajo ya avanzó, no repetirlo ni reabrir bloqueos resueltos.
- Registrar las decisiones aplicables, reparar solo lo pendiente y medir consultas evitables, transiciones, llamadas remotas y resultados. La disponibilidad del servicio y de una sesión real es requisito para esta aceptación, no para desarrollar el fix.

## Set ampliado de pruebas

### A. Regresiones de contrato y autoridad

1. Desviación de proceso cubierta por política permite reparación sin nueva pregunta.
2. Misma desviación en una segunda WU dentro del alcance delegado funciona sin ampliar la política.
3. Una excepción de WU063 no se aplica a WU066 ni a otro Epic.
4. Dos decisiones independientes llegan completas al builder y al reviewer.
5. Decisión sustituida explícitamente, decisión incompatible y decisión ajena producen tratamientos distintos.
6. Fuente manipulada, propuesta no aprobada, revisión obsoleta y campos duplicados se rechazan sin mutación parcial.
7. Recuperación de proceso no resuelve publicación, importación de SKU extras, permisos ni un bloqueo de seguridad.
8. Obligaciones nuevas malformadas se rechazan; contratos históricos siguen reproduciéndose y no pierden restricciones desconocidas.

### B. Evidencia y aceptación

9. TDD requerido: RED observado sobre baseline → implementación → GREEN → review independiente.
10. GREEN sin la evidencia de proceso exigida no permite cerrar por esa ruta.
11. Implementación anterior a RED se registra como retrospectiva; los timestamps narrados no reconstruyen el orden.
12. Baseline no disponible: solo una alternativa de evidencia permitida por la política puede sustituirlo, con limitación explícita.
13. Mutaciones de conteo, idempotencia, preservación de ediciones y publicación producen fallos funcionales relevantes; se restauran antes del candidato final.
14. Una prueba que siempre pasa, un fallo exclusivo de setup o un módulo eliminado después de implementar no bastan para demostrar esas invariantes.
15. Receipt de otro WU/candidato/árbol/check, resultado FAIL o cobertura incompleta impiden PASS/cierre.
16. Cambiar el candidato después de la revisión exige la validación correspondiente; reanudar sin cambios conserva evidencia válida.

### C. Recuperación, CI y concurrencia

17. Deadline vencido con CI remoto exitoso: observar y continuar por la ruta gobernada.
18. Deadline con CI fallido, pendiente, inaccesible o head cambiado: distinguir resultados; no inventar éxito.
19. Dos despertares o llamadas simultáneas no duplican la transición de recuperación ni la delegación.
20. Caída antes/después de persistir un evento, enviar una continuación o recibir respuesta remota: recuperar sin perder ni duplicar efectos.
21. Reinicio con worker activo, resultado terminal no reconciliado o identidad ambigua: observar lo existente; no relanzar.
22. Pérdida de respuesta del merge: consultar el resultado remoto antes de cualquier reintento.
23. Lease vencido, sesión antigua y revisión concurrente se rechazan sin suplantación ni corrupción.
24. Cancelación explícita del usuario no es anulada por la recuperación o el supervisor.

### D. Recorridos completos y exploración de bugs adicionales

25. Fixture WU066: 73 SKU autorizados, 15 extras reportados/no importados, DEFERRED/activos y preservación de ediciones. No usar datos privados reales en CI.
26. Dos o más WUs consecutivas con reparación y reinicio entre ellas: completar el Epic sin consultas de proceso cubiertas por el mandato.
27. Misma secuencia con un cambio real de negocio: detenerse y presentar exactamente esa decisión.
28. Recorrido con tiempos de planificación excedidos: continuar sin regresión del fix de PR #40, conservando consumo y techo del Epic.
29. Instalación/actualización: perfiles administrados se actualizan y personalizados se preservan; runtime real coincide con el diagnóstico.
30. Matriz de escalamiento del modelo: decisiones técnicas reversibles, hallazgos de review, contradicción auténtica y permisos faltantes. Evaluar acciones/tool calls, no solo presencia de frases en prompts.

## Estrategia para descubrir defectos no anticipados

- **Pruebas de máquina de estados:** generar secuencias válidas e inválidas de eventos con semillas reproducibles. Comprobar invariantes tras cada paso contra un modelo de referencia pequeño, no una copia del reducer.
- **Inyección de fallos:** cortar en fronteras concretas de persistencia, lease y efectos remotos; variar el orden de callbacks. Usar reloj y scheduler controlados para evitar esperas largas y flakes.
- **Mutación focalizada del Harness:** invertir guards de identidad, clasificación, cobertura, alcance y deduplicación. Cada mutación crítica debe ser detectada por una regresión; registrar las que sobrevivan y explicar si son equivalentes o revelan un hueco.
- **Replay histórico:** corpus sintético/anónimo de logs anteriores a las políticas nuevas, con fixtures congeladas y hashes esperados. El update no puede cambiar su significado ni fabricar autoridad pasada.
- **Pruebas metamórficas:** insertar checkpoints o repetir lecturas no cambia autoridad/consumo; reintentar la misma operación conserva resultado; agregar una decisión independiente no elimina la anterior.
- **Evaluación con proveedor real:** escenarios pequeños con transcripts y resultados esperados. Repetir un conjunto fijo para detectar comportamiento variable; no llamar determinista a una prueba LLM ni sustituir con ella las invariantes del controlador.

Todo fallo encontrado debe producir semilla/fixture mínima y quedar como regresión. No se cerrará el trabajo basándose solo en porcentaje de cobertura o número de tests.

## Ejecución de las suites

| Nivel | Cuándo | Contenido |
|---|---|---|
| Determinista | Cada PR | Regresiones unitarias, herramientas públicas, wiring, replay y recorridos con adaptadores locales. |
| Exploración acotada | Cada PR relevante | Semillas fijas y fallo inyectado en las fronteras modificadas; mostrar la semilla si falla. |
| Ampliado | Antes de integrar el conjunto | Más semillas, concurrencia, matriz de interrupciones y mutaciones de guards críticos. |
| Runtime real | Antes de declarar resuelto operacionalmente | Carga de perfiles, herramientas expuestas, sesión padre/hijos y recuperación de un caso autorizado. |

Los nombres de comandos nuevos se concretarán durante la implementación; hoy siguen disponibles `npm run check` y el reproductor de la auditoría. No hay suites nuevas ejecutadas por crear este plan.

## Criterios de cierre

- H1–H7 tienen cambio o resolución documentada y evidencia vinculada.
- Los probes originales tienen regresiones que ahora demuestran el comportamiento esperado.
- Cero solicitudes de aprobación adicionales en los escenarios cubiertos por autoridad vigente; preguntas justificadas en los escenarios negativos.
- Cero aceptación sin evidencia requerida y cero ampliaciones silenciosas de scope, permisos o política de merge.
- Replay histórico, identidad, contabilidad y recuperación de efectos ambiguos conservados.
- CI del head exacto PASS; el árbol integrado coincide con el verificado.
- Canary real completado, o límite de validación expresamente reportado. Pruebas locales no se presentan como resolución del servicio del usuario.
