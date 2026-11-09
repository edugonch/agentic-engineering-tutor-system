# Solo Developer — entrega local sin autoridad de CI remoto

El antiguo modo `SOLO_CI` era un error de diseño: atribuía autoridad a GitHub Actions y producía esperas incluso cuando la evidencia local del cambio era suficiente. **Está deprecado para entregas nuevas.** Los eventos históricos se conservan y siguen siendo reproducibles; no se editan recibos ni decisiones anteriores.

## Contrato efectivo

Para una WU de bajo riesgo, el propietario puede aprobar una sola política de `SOLO_LOCAL` con IDs exactos de WUs existentes y un conjunto pequeño de verificaciones locales **ya declaradas en el contrato de cada WU**. Esas verificaciones deben estar presentes como recibos inmutables `verify-<hash>`, ejecutados contra el candidato congelado y con resultado real PASS. La aceptación no se genera a partir de un texto del modelo ni de CI remoto.

Ejemplo de línea única en una nueva decisión aprobada, ligada al Epic:

```text
solo_delivery: {"execution_id":"alfran-epic05-delivery","mandate_id":"<MANDATO_REAL>","mode":"SOLO_LOCAL","checks_by_wu":{"E05-27-E":["<CHECK_LOCAL_REAL_1>","<CHECK_LOCAL_REAL_2>"]}}
```

Sustituir placeholders con `status.mandate.mandate_id` y los IDs exactos **ya existentes y realmente ejecutados** de E05-27-E. No inventar nombres de checks ni reducir silenciosamente el contrato. La autorización del propietario para acotar verificaciones debe quedar documentada; los cambios críticos no se declaran de bajo riesgo por inferencia.

La decisión se registra mediante el mecanismo normal de conocimiento aprobado y se activa una vez mediante:

```text
harness_execution_controller(action="adopt_solo_delivery", execution_id="alfran-epic05-delivery", decision_artifact_id="<ID_APROBADO>")
```

Si ya se había adoptado una antigua política `SOLO_CI`, se permite **solo** sustituirla por una nueva política aprobada `SOLO_LOCAL` para un subconjunto de las mismas WUs. El evento viejo permanece en el journal y no autoriza ninguna entrega nueva.

## Flujo mínimo

1. Reutilizar el candidato congelado de la WU. No lanzar otro builder si ya existe implementación. Corroborar el diff permitido.
2. Comprobar que existen recibos PASS locales, íntegros y del mismo candidato/contrato para **cada check seleccionado por el propietario**. Si faltan, ejecutar solo esos checks con `harness_run_verification`, nunca toda una suite innecesaria.
3. Vincular PR, HEAD y base exactos mediante `bind_pr`. Llamar `harness_merge_candidate` una vez. El motor reutiliza los recibos, registra `SOLO_LOCAL_ACCEPT` — **no un PASS falso de reviewer** — y valida árbol del candidato / PR / base antes de su merge governado.
4. `complete_wu` solamente cuando el merge esté VERIFICADO, el estado limpio y sin dispatches pendientes; avanzar con la siguiente WU ya autorizada.

## GitHub CI: sin autoridad

- **Nunca llamar `getChecks` ni esperar GitHub Actions** como parte de `runMergeCandidate`, `runVerifyExternalMerge`, `observeMergeProgress` o `runRebindPR`.
- `required_ci_checks`, `RECORD_CI` y recibos antiguos siguen siendo legibles como metadatos históricos, **sin bloquear nuevas entregas**. Pueden ser útiles para observabilidad, pero no conceden aceptación.
- Verificar el HEAD, base, integridad del árbol y confirmación del merge **sí** sigue siendo necesario: son pruebas de qué código se integró, no de CI.
- El modo ordinario sin `SOLO_LOCAL` sigue exigiendo una revisión independiente cuando así lo requiere su política. No se deshabilitan aprobación de alcance, control de acceso, pruebas reales, TDD obligatorio ni obligaciones de proceso.

## E05-27-E

Se conocen recibos locales PASS del test focalizado y varias verificaciones; el `jit-test` global sufrió un timeout. Para cerrar la WU, la nueva política debe nombrar una **selección verificable de checks locales previamente declarados** y usar sus recibos inmutables. El test focalizado 11/11 no puede registrarse artificialmente como un check que nunca estuvo declarado. Si los checks seleccionados no tienen recibos, ejecutar los checks admisibles y acotados. No volver a lanzar reviewer que falla HTTP 400 ni crear un nuevo builder.

La integración definitiva se realiza en el OpenCode local, porque allí reside el controller `alfran-epic05-delivery`. Fusionar GitHub fuera de él no equivale a `complete_wu`.
