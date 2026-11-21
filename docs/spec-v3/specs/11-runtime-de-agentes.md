# 11. Runtime de agentes (F1)

### T11.1. Capa LLM
- **Leer**: `docs/08-stack-y-repo.md` (LLM), `docs/90-decisiones.md` ADR-007.
- **Hacer**: `packages/llm` con `getModel(workspaceId, {provider, model})` sobre Vercel AI SDK; claves desde `Credential LLM_*` vía `packages/vault` (no pasan por Composio); tabla de precios por modelo para calcular costo; `listModels()` (incluye Ollama `/api/tags` y LM Studio `/v1/models`).
- **Modo port** para locales: `../tropa-desktop/local-providers.mjs`.
- **Hecho cuando**: test con proveedor fake que devuelve texto y tool calls; `GET /v1/models`.

### T11.2. Registro de tools
- **Leer**: `docs/02-conceptos.md` (Tools).
- **Hacer**: `packages/tools` con `defineTool`, `registry.list()`, `registry.forAgent(agent, face)` que filtra por `AgentTool`, scope y conexión disponible; dos fuentes: tools nativas y tools de apps (`app.*`) publicadas por `ComposioGateway` (spec 16); conversión a formato de tools del AI SDK; `GET /v1/tools`.
- **Hecho cuando**: tests de filtrado por cara y por conexión faltante.

### T11.3. Contexto del run
- **Hacer**: `buildContext(run)`: prompt de sistema del agente + reglas fijas (cara, fecha y huso, horario) + memoria relevante + historial de la conversación (últimos N mensajes y resumen) + mensajes de contacto envueltos como datos no confiables.
- **Hecho cuando**: snapshot tests para cara externa e interna.

### T11.4. Loop con checkpoints
- **Leer**: `docs/06-confiabilidad.md`.
- **Hacer**: `executeRun(runId)`: llama al LLM con streaming, persiste cada `RunStep`, ejecuta tools con `ToolContext`, respeta `maxStepsPerRun`, emite `message.delta`, `tool.*`, `run.*`; acumula tokens y costo; reanuda desde `RunStep`.
- **Hecho cuando**: tests: run simple; run con 2 tools; corte por límite de pasos; caída simulada a mitad y reanudación sin repetir tools idempotentes.

### T11.5. Cola de runs
- **Hacer**: colas `run.execute` y `run.resume`; `group: { id: conversationId }` con `groupConcurrency: 1`; heartbeat y barrido de runs huérfanos al arrancar.
- **Hecho cuando**: dos mensajes simultáneos en la misma conversación se procesan en orden.

### T11.6. Outbox
- **Hacer**: `packages/core/outbox` con `outbox.run(key, kind, target, payload, fn)` que inserta `OutboundSend`, ejecuta, guarda `externalId` o marca `FAILED` o `UNKNOWN`.
- **Hecho cuando**: llamar dos veces con la misma clave ejecuta `fn` una sola vez.

### T11.7. Tool docs.generate
- **Modo port**: `../tropa-desktop/document-mcp.mjs`.
- **Hacer**: tool interna que genera PDF, DOCX o XLSX y lo guarda como archivo descargable (`/v1/files/:id`).
- **Hecho cuando**: test que genera los tres formatos.
