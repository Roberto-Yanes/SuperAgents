# orchestration/ — Capa 03 · Orquestación e inteligencia

```
orchestration/
  runtime/
    agent-runtime.ts  Solo orquesta el bucle de tool calling (execute / resume)
    run-store.ts      Ciclo de vida del run: carga, toma atómica, checkpoint, cierre; StepRecorder
    tool-binder.ts    Tools resueltas → formato AI SDK; ejecución validada con su contexto
    reply-delivery.ts Respuesta final → outbox (mensaje saliente + message.outbound)
    prompt.ts         Prompt de sistema e historial → mensajes del modelo
  approvals/
    approval-gate.ts  Pausar en aprobaciones y, al reanudar, ejecutar lo aprobado una sola vez
    service.ts        Listar, decidir (atómico), caducar y reanudar runs
  llm/
    registry.ts       Capa LLM: "conexión:modelo" → OpenAI, Anthropic, Gemini u OpenAI-compatible (Ollama, LM Studio)
    tester.ts         Prueba de credenciales LLM listando modelos (sin gastar tokens)
```

Cómo funciona una aprobación:

1. Las tools con modo efectivo ASK_OWNER o ALWAYS se entregan al modelo **sin `execute`**: el SDK detiene el bucle y deja la llamada pendiente. Las automáticas del mismo paso sí se ejecutan.
2. El runtime guarda una `Approval` por llamada pendiente y pone el run en `WAITING_APPROVAL`, con el historial como checkpoint.
3. Al decidir la última pendiente se encola `run.resume`: se ejecuta lo aprobado una sola vez (con su `idempotencyKey`), se añade el resultado al historial y el bucle continúa.

Siguientes módulos: `memory/` (hechos con embeddings en pgvector, RAG) y `orchestrator/` (equipos de agentes, delegate_task, handoff). Ver docs/ROADMAP.md.
