# 12. API pública y streaming (F1)

### T12.1. Agentes
- **Leer**: `docs/04-api-publica.md` (Agentes).
- **Hacer**: CRUD de `/v1/agents`, `/tools`, `/channels`, `/knowledge` del agente; estado calculado (runs activos).
- **Hecho cuando**: tests de API con scopes.

### T12.2. Chats internos
- **Hacer**: `/v1/chats` y `/v1/chats/:id/messages` (crea `Message USER`, `Run USER_CHAT`, encola, responde 202).
- **Hecho cuando**: test de extremo a extremo con LLM fake: el mensaje del agente queda guardado.

### T12.3. SSE
- **Hacer**: `GET /v1/chats/:id/stream?runId=` que se suscribe a eventos del run (LISTEN/NOTIFY) y soporta `Last-Event-ID`.
- **Hecho cuando**: test que recibe `message.delta` en orden y `run.finished`.

### T12.4. Suscripción a runs por WS
- **Hacer**: `subscribe {runId}` en el WS para recibir los eventos de streaming.
- **Hecho cuando**: mismo test que T12.3 por WS.

### T12.5. Runs, tareas, archivos
- **Hacer**: `/v1/runs`, `/v1/runs/:id` (con pasos), `/v1/runs/:id/cancel`, `/v1/tasks`, `/v1/files`.
- **Hecho cuando**: cancelar un run en curso lo deja `CANCELLED` y corta el stream.

### T12.6. SDK TypeScript
- **Hacer**: `packages/sdk` generado desde OpenAPI más helpers a mano para SSE y WS (`client.chats.stream(runId, handlers)`).
- **Hecho cuando**: script de ejemplo que crea un chat, envía un mensaje e imprime el stream.
