# orchestration/ — Capa 03 · Orquestación e inteligencia

```
orchestration/
  runtime/
    agent-runtime.ts  Loop de una Task (ADR 003): un run = un tramo entre esperas (execute / resume / wake)
    task-store.ts     Persistencia de la Task: tramos, gasto, plan, pausas, bloqueo, cierre, delegación y despertar
    task-audit.ts     Registro de auditoría por tramo (decisión, datos, tools, modelo, región, resultado, costo)
    run-store.ts      Ciclo de vida del run: carga, toma atómica, checkpoint, cierre; StepRecorder
    tool-binder.ts    Tools resueltas → formato AI SDK; ejecución validada con su contexto
    reply-delivery.ts Respuesta final → outbox (mensaje saliente + message.outbound)
    prompt.ts         Prompt de sistema e historial → mensajes del modelo
  approvals/
    approval-gate.ts  Pausar en aprobaciones y, al reanudar, ejecutar lo aprobado una sola vez
    service.ts        Listar, decidir (atómico), caducar y reanudar runs
  llm/
    registry.ts       Capa LLM: "conexión:modelo" → Azure OpenAI UE, Mistral u OpenAI-compatible UE; comprueba la residencia al usar
    embeddings.ts     Embedder del workspace (settings.knowledge.embeddingModel) con la misma comprobación de residencia
    tester.ts         Prueba de credenciales LLM listando modelos (sin gastar tokens)
```

Cómo funciona una aprobación:

1. Las tools con modo efectivo ASK_OWNER o ALWAYS se entregan al modelo **sin `execute`**: el SDK detiene el bucle y deja la llamada pendiente. Las automáticas del mismo paso sí se ejecutan.
2. El runtime guarda una `Approval` por llamada pendiente y pone el run en `WAITING_APPROVAL`, con el historial como checkpoint.
3. Al decidir la última pendiente se encola `run.resume`: se ejecuta lo aprobado una sola vez (con su `idempotencyKey`), se añade el resultado al historial y el bucle continúa.

Cómo corre una Task (ADR 003):

1. Toda ejecución pertenece a una Task. `POST /v1/tasks` crea una de la app; un mensaje de canal, una rutina o una secuencia crean una corta al arrancar su run (`TaskStore.ensureTask`).
2. Antes de la primera llamada al modelo de cada tramo: residencia UE del modelo (si no cumple → `BLOCKED model_region`) y cupo (si está agotado → `BLOCKED`).
3. Cada paso: checkpoint del run, `RunStep`, gasto (pasos = llamadas + tools; costo con la tarifa de la conexión o la de referencia, también en los ancestros) y evento `task.step`.
4. El tramo se corta sin otra llamada si: se agota el cupo (calculado con los pasos del propio tramo en `stopWhen`), una tool pide esperar (`task.wait`) o delegó (`task.delegate`), una tool necesita aprobación o cancelan.
5. Al cerrar: `SUCCEEDED`/`FAILED`/`BLOCKED`, o pausa (`WAITING_APPROVAL`, `WAITING_EXTERNAL`, `WAITING_CHILD`) con el reloj parado si `pauseClockOnWait`. El checkpoint queda en la Task.
6. `task.wake` abre un tramo nuevo desde el checkpoint de la Task más una nota de la plataforma (plazo cumplido, dato del dueño, resultado de las hijas, cupo ampliado). Solo despierta si esa espera sigue vigente.

Las tools de tarea (`plan.update`, `task.wait`, `task.delegate`) se añaden solas a las tareas de cara interna que no son de canal. La política de riesgo del workspace (`domain/workspaces/risk-policy.ts`) se aplica al resolver las tools.

Memoria en tres capas: la del contacto entra en la cara externa de ese contacto; las notas del agente (`contactId` nulo) solo en tareas de cara interna; el conocimiento del negocio se consulta con `kb.search` (`domain/knowledge`). Ver docs/ROADMAP.md (E6).
