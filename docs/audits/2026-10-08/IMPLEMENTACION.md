# Implementación y evidencia de la reparación

8 de octubre de 2026. Base auditada: `f094b038f1f036a55eb6f375fcac6d15678c8792`.

Los cambios reparan defectos reproducidos del controlador y conectan el plugin con el SDK fijado en `@opencode/plugin@2.0.25`. **No constituyen aún aceptación integral del plan E0–E8.** El supervisor automático está desactivado por defecto. No se ha intervenido la ejecución productiva de ALFRAN, modificado sus cargos ni ampliado sus autorizaciones.

## Validación realizada

- `npm run check`: validación del paquete y 453 pruebas aprobadas, cero fallos, en Node 24.19.0. CI declara Node 22 y usa `npm ci --ignore-scripts` con lockfile.
- Ocho regresiones seleccionadas fallan contra la base auditada y pasan en esta implementación: F01, F02 (árbol remoto divergente), F07, F09 (CI previo a STARTED), F11, F14, F15 y F19. La comparación se realizó retrospectivamente; no se afirma RED histórico anterior a implementar.
- Para ejecutar las nuevas pruebas sobre la base se copiaron los fixtures y el calculador de árbol Git usado por los fixtures; no se sustituyó su controlador ni su implementación de merge.
- `tests/plugin-wiring.test.js` carga el entrypoint y el SDK reales con un host controlado: toma de posesión desde Build, rechazo de la llamada anterior, prepare/release/prepare, captura de identidad hija, contrato en contexto, handoff y consumo observado. **No es un proveedor real de OpenCode.**
- Regresiones adicionales verifican revisión repetida, presupuesto original, contrato divergente, setup aislado, cancelación, temporización de reserva, rebind con CI nueva, recuperación del supervisor y ausencia de continuación ante interrupción del usuario.
- `git diff --check`: sin errores de formato.

## Matriz de resultados

“Implementado” describe el comportamiento comprobado por pruebas de código; no sustituye la aceptación en runtime real.

| Hallazgo | Cambio y evidencia | Estado / límite residual |
|---|---|---|
| F01 | Merge reanudado revalida bloqueos y autorización bajo mutex antes del efecto; regresión con nuevo bloqueo de seguridad. | Implementado. La política de protección remota sigue siendo necesaria para cambios concurrentes en GitHub. |
| F02 | Captura completa de archivos Git y comparación del árbol materializado con el árbol del head remoto; modos, symlinks y UTF-8 contrastados con Git real. | Implementado. Se conserva el límite existente de tamaño de candidatos. |
| F03 | Uso observado del intervalo de despacho, fallback identificado, liberación del sobrante y rechazo de doble reserva fase/worker. | Parcial: el intervalo es una cota de tiempo transcurrido, no medición exacta de actividad. La verificación raíz ya factura una fase medida, incluida cancelación/fallo, sin doble cargo dentro de workers. Faltan medición integral del razonamiento del orquestador y asignación automática entre fases. No hay devolución histórica. |
| F04 | Activación compila el límite original desde la fuente vinculada al Epic; reservas lo respetan junto a enmiendas aprobadas. | Implementado. WUs antiguas requieren asociación explícita del contrato antes de nuevas reservas. |
| F05 | Sin cortes predeterminados por pasos en especialistas; se conservan límites personalizados. Guardia de reserva interrumpe solo la sesión identificada; supervisor durable opcional. | Parcial: falta canary real de continuación; supervisor desactivado. No se garantiza continuación de cualquier límite impuesto por el proveedor. |
| F06 | `next_action` expone recuperación soportada, reutiliza la resolución de autoridad incorporada en PR #33; NO_PROGRESS exige evidencia nueva. | Parcial: no existe todavía recuperación general para toda decisión de seguridad/permisos/rebase de Epic. La espera de CI pendiente y HTTP transitorio ya tiene scheduler durable y backoff; no convierte rechazos de seguridad/permisos en reintentos. |
| F07 | Release elimina el binding exacto, prepare se reconstruye tras reinicio y no se lanza especialista sin claim válido. | Implementado con pruebas del registry y del plugin completo. |
| F08 | Identidad de revisión por dictamen/evidencia/reviewer y conservación de historial. | Implementado para conflictos de re-revisión. La independencia efectiva de la persona/agente sigue necesitando comprobación en el flujo real. |
| F09 | CI se comprueba antes de STARTED; intentos identificados, rebind invalida CI antigua; aborto solo ante PR cerrado sin merge confirmado. | Implementado para casos cubiertos. Un resultado remoto ambiguo exige observación; nunca se cancela por suposición. |
| F10 | Setup declarado, timeout contractual limitado por presupuesto, cancelación del grupo de procesos y receipts de resultados. | Implementado para comandos declarados. No provisiona automáticamente servicios externos; aislamiento de red requerido sigue bloqueando cuando no puede aplicarse. |
| F11 | Sin defaults optimistas de probes/presupuesto; contrato durable, escritura de workspace, binarios de setup, perfiles y capacidad de interrupción. | Parcial: no demuestra anticipadamente todos los permisos dinámicos, servicios, instalación de dependencias ni políticas remotas. |
| F12 | Freeze toma el contrato activo; record_candidate compara hashes; contexto de especialistas incluye contrato y resolución de autoridad. | Parcial: comandos y presupuesto están vinculados. Las obligaciones de proceso se transportan, pero no todas tienen enforcement determinista; no se fabrica RED histórico. |
| F13 | Cambios observables de PR/CI habilitan otro intento sin reiniciar la guarda; checkpoints no simulan progreso. | Implementado para merge/CI y errores HTTP transitorios tipados, con backoff durable que sobrevive reinicios. Otros errores conservan diagnóstico y no se reclasifican automáticamente. |
| F14 | Paginación, último intento por ID/proveedor, rechazo de colisiones, commit statuses y timeout HTTP. | Implementado. La política exige nombres; colisiones ambiguas se rechazan en lugar de elegir un proveedor por intuición. |
| F15 | Validación de hashes v1/v2 antes de proyectar, rechazo de alteraciones y versiones desconocidas. | Implementado. Integridad accidental no equivale a firma contra un atacante que pueda reescribir todos los hashes. |
| F16 | Handoff compacto durable, aceptación UNVERIFIED, resumen y paginación; captura de identidad en frontera de contexto. | Parcial: una caída antes de capturar identidad y compaction que elimine toda evidencia todavía exige recuperación conservadora. |
| F17 | SDK fijado, lockfile, CI reproducible, fingerprint del paquete y perfiles efectivos; migración solo de límites predeterminados conocidos. | Parcial: SDK y wiring probados; combinación con host/proveedor real y perfiles instalados de ALFRAN aún no comprobada. |
| F18 | Regresiones y wiring completo, diagnóstico de migración de solo lectura, protocolo y recolector ejecutable de canary. | Pendiente: canary real sostenido, copia fiel del estado de ALFRAN y aceptación integral. |
| F19 | Estado completed rechaza nuevas mutaciones de avance; permite observación, checkpoints y liquidación explícita existente. | Implementado y probado. |

## Aplicación segura a una ejecución existente

1. Conservar una copia consistente del estado y registrar versión/perfiles efectivos del host antes de actualizar. No restaurar esa copia sobre una ejecución que haya producido nuevos efectos remotos.
2. Ejecutar desde este checkout: `node scripts/inspect-execution.mjs /ruta/alfran-web-platform alfran-epic03-continuation`. Es de solo lectura: no toma leases ni escribe eventos. Si la integridad falla, investigar antes de mutar.
3. Cargar el plugin actualizado en OpenCode y consultar `status` y `verify`. Los 500 s y la revisión 49 son datos históricos aportados por el usuario; no se asumen vigentes.
4. Si sigue BLOCKED_AUTHORITY, usar `resolve_authority_blocker` con la decisión ya aprobada `WU063-RETROSPECTIVE-VALIDATION-OWNER-AUTHORIZATION` y la identidad exacta del bloqueo. `clear_blocker` no es la transición de autoridad. No solicitar de nuevo una aprobación aplicable.
5. Si el contrato está LEGACY_UNBOUND o requiere normalización, usar `bind_wu_contract` preservando fuente, criterios y presupuesto; declarar comandos ejecutables sin debilitar el contrato. No editar el event log manualmente.
6. Inspeccionar el despacho existente y su handoff antes de lanzar otro. Mantener la rama parcial y los cargos. Continuar validación retrospectiva, GREEN, revisión independiente y gates de integración bajo el presupuesto vivo.
7. No avanzar WU064 antes de `complete_wu` de WU063. No interpretar este informe como ampliación de presupuesto.

Declaración obligatoria de la excepción ya aprobada para WU063:

> TDD ordering deviation: implementation preceded the required RED execution. No historical RED evidence exists. Retrospective validation was explicitly authorized by the owner.

## Canary real y criterio de promoción

Usar un repositorio de prueba, el SDK fijado y un host OpenCode compatible, con mandato aprobado que cubra varias WUs y más de 30 minutos de trabajo efectivo. Registrar versiones, fingerprints, log durable y trazas de sesiones. No reutilizar los 500 s históricos de WU063 para esta prueba.

| Escenario | Resultado exigido |
|---|---|
| Orden desde Build | Ownership del orquestador antes de la primera mutación; llamada antigua sin ejecutar. |
| Trabajo largo, yield y compaction | Identidad estable, handoff accesible y continuación sin intervención por defectos internos. |
| Caída entre intención, lanzamiento y respuesta | Observar/reconciliar una única sesión; no duplicar builder. |
| Revisión CHANGES_REQUIRED y corrección | Conservar ambos dictámenes y exigir evidencia vigente. |
| CI pendiente, fallida y recuperada | Continuar al cambiar la evidencia; sin bucles ni merge prematuro. |
| Reinicio tras efecto remoto | Un único merge, comprobación del contenido exacto y recuperación idempotente. |
| Usuario interrumpe o presupuesto termina | No reanudar contra la interrupción; conservar reservas/cargos y explicar la condición pendiente. |
| Decisión aprobada aplicable | Resolver el bloqueo exacto una vez, sin volver a pedir aprobación. |

Solo en ese entorno controlado habilitar `HARNESS_SUPERVISOR_ENABLED=1`. No promoverlo por defecto hasta superar los escenarios y cerrar los pendientes de recuperación/esperas y contabilidad indicados arriba. Las pruebas actuales no acreditan 30 minutos de autonomía real ni el cierre de EPIC-03.

## Compatibilidad y reversión

Los lectores actuales comprenden hashes históricos v1/v2. Los nuevos eventos de contratos, medición, handoff, supervisor y abortos exigen un lector compatible; después de emitirlos, no hacer downgrade a un binario que los ignore. Preferir reparación hacia adelante. No borrar eventos, fabricar evidencia ni reiniciar reservas para desbloquear.


## Continuación del 9 de octubre (UTC)

Se implementaron los pendientes de espera y consumo de verificación que la primera entrega había dejado abiertos:

- `EXTERNAL_WAIT`, `EXTERNAL_WAIT_DUE` y `EXTERNAL_WAIT_END`: demora progresiva de 15 s a 300 s, deadline durable y resolución/expiración registrada. El contrato admite `external_wait_seconds`; default 1800 s para una condición externa persistentemente indisponible. Esa espera no factura tiempo activo ni amplía el presupuesto.
- El supervisor restaura timers tras reinicio y emite una continuación por intento vencido. Un bloqueo o interrupción del usuario impide despertar. Sigue desactivado por defecto hasta la prueba real.
- El adaptador distingue CI pendiente, HTTP 429/5xx y fallos de transporte de fallos funcionales, permisos y divergencia de head. El controlador actualiza CI mediante observación remota del head vinculado, sin necesitar que el modelo fabrique un resultado SUCCESS.
- Verificación raíz: admite una fase acotada por contrato y presupuesto disponible, mide duración, liquida en `finally` e impide solapamiento/cierre mientras está activa. Dentro de un worker se conserva el cargo único de su intervalo.
- El comando de verificación tiene un proceso guardián que mata su grupo si desaparece el host. La prueba mata realmente al proceso propietario y verifica que el comando no continúa hasta escribir su resultado tardío. Mantiene las limitaciones POSIX previamente documentadas; no es un contenedor.
- `harness_recover_verification` rechaza un propietario vivo. Para un propietario muerto con guardia compatible liquida conservadoramente la asignación autorizada, preserva `UNKNOWN_NOT_ACCEPTANCE` y nunca registra PASS. La identidad de fase impide liquidar otra ejecución.
- `scripts/collect-continuity-canary.mjs` usa el cliente OpenCode instalado para obtener versión, plugins, sesiones sanitizadas y copia verificable del log. Es de solo lectura, no inicia modelos ni servicios y nunca convierte tiempo transcurrido en prueba de autonomía.

Ejecución del recolector en la máquina que tiene el servicio OpenCode y el repositorio de canary:

```bash
node scripts/collect-continuity-canary.mjs /ruta/repositorio-canary EXECUTION_ID /ruta/nueva/canary-evidence.json
```

El directorio de salida debe existir y el archivo debe ser nuevo. El archivo contiene contexto de las sesiones del canary y debe conservarse con sus evidencias, sin publicarlo automáticamente.

Comprobación local de disponibilidad mediante `Service.discover()`: `real_opencode_service_available=false`. Esto bloquea aquí la prueba con proveedor real; no bloqueó las correcciones, sus pruebas ni la creación del recolector. Los restantes alcances parciales de la matriz no se declaran cerrados por estos resultados.

## Follow-up: WU063 verification host and reviewer admission

ALFRAN reported a frozen candidate whose declared setup invoked the OpenCode CLI
with command-host arguments, and a reviewer rejected by the parent's lease.

- `runCommand` incorrectly assumed `process.execPath` was a JavaScript runtime.
  In the packaged OpenCode host it can be the OpenCode executable. The command
  host now uses `node` from the same PATH as declared npm/node commands. The
  launch still uses argv, a detached process group, cancellation and owner-death
  cleanup. Node must be available in the OpenCode service PATH (Node 24 for
  ALFRAN); changing the terminal PATH alone does not change an existing service.
- Verification previously classified an unbound pending child as root work.
  It now accepts the pending worker reservation only with an exact runtime
  parent/tool-call/agent/child match. Runtime identity is read through the SDK,
  not accepted as model tool input. No parent lease is acquired or transferred,
  no launch identity or completion is invented, and the reservation remains
  responsible for consumption. Missing/conflicting evidence fails with
  `HARNESS_DISPATCH_IDENTITY_REQUIRED` rather than attempting root admission.
- Regression tests reproduced both failures before the changes. Package
  validation and all 455 tests pass after the changes, including cancellation,
  timeout and host-death cleanup. This does not constitute real OpenCode
  acceptance: the service is unavailable in this environment.

Resume the existing frozen candidate after plugin update/service restart and
supported resolution of the runner tooling blocker. Preserve the current
budget, retrospective authorization and candidate; rerun declared checks and a
fresh independent review before acceptance/CI/merge. Do not reimplement WU063 or
claim that its reported local GREEN constitutes independent review.

## Follow-up: live dispatch progress and explicit contract corrections

ALFRAN checkpoint 111 confirms the Node command-host fix worked (typecheck PASS),
but the reviewer still could not resolve its dispatch. The prior fix depended
on the parent context exposing a running call. The plugin now observes the
supported `subagent` progress callback directly, validates the actual child via
`session.get`, and persists the exact claimed identity before the child proceeds.
Original progress/results are preserved. No matching by agent name alone, model
supplied child ID, or lease transfer is introduced. Restart recovery and terminal
accounting remain unchanged. Real-host confirmation remains pending.

The new controller action `correct_verification_contract` requires:

- An exact `wu_artifact_id` for an APPROVED WU source linked to the existing Epic.
- The current `expected_contract_hash` (compiled WU hash, not candidate hash).
- A nonempty `reason` and complete `check_mapping` from old check IDs to new IDs.
- Preserved WU scope/acceptance prose before `execution_contract`, original
  budget, process obligations and environment policy. Generated knowledge
  envelopes/titles are excluded from the prose comparison.
- Settled dispatches and phases, no pending external wait or merge, and no
  unresolved non-tooling blocker.

It appends `WU_CONTRACT_CORRECT`, retains the prior contract and all receipts,
marks old WU candidates superseded and clears only the current PR binding.
It does not clear the blocker or change budget. Superseded candidates cannot be
reviewed, rebound, used for CI acceptance, merged or completed. Refreeze the
same code under the corrected contract, rerun every declared check, and obtain
a fresh independent review. Check mapping is traceability, not proof that the
commands preserve coverage; the reviewer must inspect that equivalence.

For ALFRAN V4, inspect the current controller state and approved record
`fa29b273cd9c0624713058688cea2ca1854698d600402052097b36a41d443f5d`.
Map old `tests` to `commerce-tests`, `api-tests`, `crm-migration-tests`, and map
each unchanged check (types/lint/format/arch) to itself if those are the actual
old IDs. Call `correct_verification_contract` with the current compiled hash
and reason. Resolve only the tooling blocker whose causes are repaired. Preserve
PR #165/head `478eb0387a09eb87a0ce0b3f2663311e1bc89ed5` unless actual checks require
code changes. Prior timeout/DB failures remain failures until rerun establishes
their cause. Preserve retrospective authorization and current live budget;
no budget extension, event edits or implementation restart is authorized here.
