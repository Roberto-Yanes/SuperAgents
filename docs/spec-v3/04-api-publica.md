# 04. API pública

Contrato de primera clase: la UI estilo Grok Bot y cualquier integración usan **solo** esto. Se publica como **OpenAPI 3.1** generado desde los esquemas zod (`/v1/openapi.json`) y un **SDK TypeScript** (`packages/sdk`).

## Convenciones

- Base: `https://<host>/v1`. JSON, `camelCase`, fechas ISO 8601 UTC.
- Paginación por cursor: `?limit=50&cursor=<opaque>` → `{ data: [...], nextCursor }`.
- Errores: `{ error: { code, message, details? } }` con HTTP 400/401/403/404/409/422/429/500. Códigos estables (`agent_not_found`, `approval_expired`, `channel_disconnected`…).
- **Idempotencia**: todo `POST` que crea o envía acepta `Idempotency-Key`; se guarda 24 h en `IdempotencyRecord` y se devuelve la misma respuesta.
- Workspace implícito: lo da la credencial. En modo multitenant, header `X-Workspace-Id` cuando un usuario pertenece a varios.
- Rate limit por credencial (`429` con `Retry-After`).

## Auth

| Tipo | Uso | Cómo |
|---|---|---|
| Sesión de usuario | UI | Better Auth (email y contraseña; luego Google). Cookie `HttpOnly` para web; **bearer token** para desktop y móvil ⚠ VERIFICAR plugin bearer de Better Auth |
| API key | Integraciones, UI headless sin login | `Authorization: Bearer pk_<prefijo>_<secreto>`; scopes; se ve una sola vez al crearla |
| Token de WS | WebSocket | `POST /v1/ws-tickets` → ticket de un uso, 60 s; `wss://<host>/v1/ws?ticket=...` |
| Webhooks entrantes | Meta, rutinas | Firma (`X-Hub-Signature-256`) o token por URL |

Scopes: `agents:read|write`, `chats:read|write`, `inbox:read|write`, `contacts:read|write`, `leads:read|write`, `tasks:read|write`, `approvals:read|write`, `routines:read|write`, `connections:read|write` (incluye `app-tools` y `credentials`), `channels:read|write`, `admin`.

## Recursos y endpoints

### Workspace, usuarios, keys

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/me` | Usuario, rol, workspace, flags |
| GET/PATCH | `/workspace` | Nombre, huso, idioma, settings |
| GET/POST | `/members` · DELETE `/members/:id` | Miembros y roles |
| GET/POST | `/api-keys` · DELETE `/api-keys/:id` | Crear (devuelve secreto una vez), revocar |

### Agentes y equipos

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/agents` | Lista con estado (`idle`, `busy`, `n runs activos`), avatar, cara |
| POST | `/agents` | Crear desde cero |
| GET/PATCH/DELETE | `/agents/:id` | Ver, editar (prompt, modelo, límites, horario), archivar |
| GET/PUT | `/agents/:id/tools` | Tools habilitadas y overrides de aprobación |
| GET/PUT | `/agents/:id/channels` | Canales que atiende |
| GET/PUT | `/agents/:id/knowledge` | Fuentes de conocimiento |
| GET | `/tools` | Catálogo con scope, riesgo, aprobación default, conexión requerida |
| GET | `/models` | Modelos disponibles según conexiones LLM (incluye locales detectados) |
| GET/POST | `/teams` · GET/PATCH/DELETE `/teams/:id` | Equipos, coordinador, miembros y permisos de delegación |

### Chat interno (estilo Grok Bot)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/chats?agentId=` | Conversaciones INTERNAL del usuario |
| POST | `/chats` | `{ agentId \| teamId, title? }` → nueva conversación |
| GET/PATCH/DELETE | `/chats/:id` | Ver, renombrar, archivar |
| GET | `/chats/:id/messages?cursor=` | Historial (incluye pasos de tools resumidos) |
| POST | `/chats/:id/messages` | `{ content, attachments? }` → `202 { messageId, runId }` |
| GET | `/chats/:id/stream?runId=` | **SSE** del run (ver abajo); también llega por WS |
| POST | `/runs/:id/cancel` | Cancelar |
| POST | `/files` | Subir adjunto (multipart) → `{ fileId }`; GET `/files/:id` descarga |

### Inbox (cara externa)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/conversations?status=&channelId=&assigned=me` | Bandeja |
| GET | `/conversations/:id` · `/conversations/:id/messages` | Detalle e historial |
| POST | `/conversations/:id/takeover` | Un humano toma la conversación (el agente deja de responder) |
| POST | `/conversations/:id/release` | Devolver al agente |
| POST | `/conversations/:id/messages` | Mensaje humano al contacto (respeta ventana de 24 h; fuera de ella exige `templateName`) |
| POST | `/conversations/:id/close` | Cerrar |

### Contactos, leads, agenda

| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/contacts` · GET/PATCH `/contacts/:id` | Con identidades, tags, opt-out |
| GET | `/contacts/:id/timeline` | Mensajes, leads, turnos, secuencias |
| GET/POST | `/pipelines` · `/pipelines/:id/stages` | Embudo |
| GET/POST | `/leads` · PATCH `/leads/:id` · POST `/leads/:id/move` | Leads (espejo opcional en el CRM conectado por Composio) |
| GET | `/appointments?from=&to=` | Turnos creados por la plataforma |

### Tareas, runs, aprobaciones

| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/tasks` · GET/PATCH `/tasks/:id` | Asignar trabajo a un agente o equipo |
| GET | `/runs?agentId=&status=` · GET `/runs/:id` | Runs con pasos, tokens, costo |
| GET | `/approvals?status=PENDING` | Pendientes |
| POST | `/approvals/:id/decide` | `{ decision: "approve" \| "reject", note?, editedPayload? }` |

### Conexiones y canales

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/connections/toolkits?search=&category=` | Catálogo de toolkits de Composio (slug, nombre, logo, tipo de auth, cantidad de acciones y triggers) con la marca `connected` |
| GET | `/connections/toolkits/:slug/actions` | Acciones del toolkit con schema, riesgo inferido y si ya están habilitadas como `AppTool` |
| POST | `/connections` | `{ toolkit, owner: "workspace" \| "member", label?, returnUrl }` → `{ connectionId, redirectUrl }`. Crea la `Connection` en `INITIATED`, guarda el ID del connected account que devuelve `connectedAccounts.link` y devuelve el Connect Link de Composio. Sirve igual para OAuth (Google) y para API key (Holded): Composio hospeda el formulario y la clave nunca pasa por nuestro servidor |
| GET | `/connections/callback?nonce=…` | Callback público al que Composio devuelve el navegador. Con el `nonce` busca la `Connection`, **lee el connected account desde Composio** (no confía en la query), verifica que el `user_id` y el ID coincidan con lo guardado, actualiza `accountRef` y `status`, y redirige a `returnUrl` |
| GET | `/connections` · GET `/connections/:id` | Connected accounts del workspace: toolkit, dueño, `status` (`INITIATED`, `ACTIVE`, `NEEDS_REAUTH`, `FAILED`, `DISABLED`), sin secretos |
| POST | `/connections/:id/reconnect` | Nuevo Connect Link para una conexión vencida |
| DELETE | `/connections/:id` | Borra el connected account en Composio y desactiva sus `AppTool` y triggers |
| GET/POST | `/app-tools` · PATCH/DELETE `/app-tools/:id` | Habilitar acciones como tools: `{ toolkit, actionSlug, scope, defaultApproval }`; fija `toolkitVersion` |
| POST | `/connections/:id/triggers` · DELETE `/connections/:id/triggers/:tid` | Activa un trigger de Composio (`{ triggerSlug, config, target }`) |
| POST | `/webhooks/composio` | Entrega de triggers y eventos de ciclo de vida de conexiones. Público, verificado con la firma de Composio (`triggers.verifyWebhook`) |
| GET/POST | `/credentials` · DELETE `/credentials/:id` · POST `/credentials/:id/test` | Secretos propios que no son de Composio: claves de LLM y SMTP (alta, prueba, baja; nunca se devuelven) |
| GET/POST | `/channels` · GET/PATCH/DELETE `/channels/:id` | Canales; `provider` BAILEYS o META_CLOUD |
| POST | `/channels/:id/baileys/link` | Inicia vínculo; el QR o el código llegan por WS (`channel.qr`) |
| POST | `/channels/:id/switch-provider` | Cambiar Baileys ↔ Cloud API conservando contactos y conversaciones |
| GET | `/channels/:id/templates` · POST sync | Plantillas de WhatsApp (Cloud API) |
| GET/POST | `/webhooks/meta` | Verificación (`hub.challenge`) y recepción firmada |

### Rutinas, secuencias, plantillas, conocimiento

| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/routines` · PATCH/DELETE `/routines/:id` · POST `/routines/:id/run` | CRON, EVENT, WEBHOOK |
| POST | `/hooks/routines/:token` | Disparo externo de rutina WEBHOOK |
| GET/POST | `/sequences` · PATCH `/sequences/:id` · POST `/sequences/:id/enroll` | Seguimientos |
| GET | `/templates` · GET `/templates/:key` | Catálogo por rubro con preguntas del configurador |
| POST | `/templates/:key/install` | `{ answers }` → crea agentes, secuencias, FAQ |
| GET/POST | `/knowledge` · POST `/knowledge/:id/documents` | Fuentes y carga de documentos |
| GET/POST/DELETE | `/memories?scope=&contactId=` | Ver y editar memoria |

### Observabilidad

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` · `/ready` | Liveness y readiness (público) |
| GET | `/usage?from=&to=` | Tokens y costo por agente y día |
| GET | `/audit?cursor=` | Auditoría |
| GET | `/events?after=<seq>` | Reproducción de eventos (fallback del WS) |

## Streaming de un run (SSE y WS)

`GET /v1/chats/:id/stream?runId=...` (`text/event-stream`). Mismos eventos por WS con `type: "run.*"`.

```text
event: run.started        data: {"runId":"...","agentId":"..."}
event: message.delta      data: {"runId":"...","messageId":"...","delta":"Hola, "}
event: tool.started       data: {"runId":"...","stepId":"...","toolKey":"calendar.check_availability","input":{...}}
event: tool.finished      data: {"runId":"...","stepId":"...","ok":true,"summary":"3 horarios libres"}
event: approval.requested data: {"approvalId":"...","toolKey":"email.send","summary":"Enviar a ..."}
event: delegation         data: {"fromAgentId":"...","toAgentId":"...","taskId":"..."}
event: message.completed  data: {"messageId":"...","content":"..."}
event: run.finished       data: {"runId":"...","status":"COMPLETED","usage":{"inputTokens":0,"outputTokens":0,"costUsd":0}}
```

Reconexión: header `Last-Event-ID` (SSE) o `{"type":"resume","afterSeq":123}` (WS).

## WebSocket de workspace

`wss://<host>/v1/ws?ticket=...`. Mensajes JSON `{ seq, type, data, at }`.

| Evento | Cuándo |
|---|---|
| `message.created` / `message.status` | Mensaje nuevo en chat o inbox / entregado, leído, fallido |
| `conversation.updated` | Estado, asignación, takeover |
| `run.started` / `run.updated` / `run.finished` | Ciclo de vida de runs |
| `message.delta`, `tool.started`, `tool.finished` | Streaming (si el cliente se suscribe al run) |
| `approval.requested` / `approval.decided` | Aprobaciones |
| `task.updated` | Tareas |
| `lead.updated` / `appointment.created` | Negocio |
| `channel.status` / `channel.qr` | Estado del canal y QR de Baileys |
| `connection.status` | Conexión de Composio activada, vencida (`NEEDS_REAUTH`) o con error |
| `integration.event` | Llegó un trigger de Composio (si alguna rutina lo escucha) |
| `routine.fired` | Disparo de rutina |

Cliente → servidor: `subscribe {runId}` · `unsubscribe` · `resume {afterSeq}` · `ping`.

## Ejemplo: chatear con un agente

```http
POST /v1/chats/9b1.../messages
Authorization: Bearer pk_7Hc2_...
Idempotency-Key: 0f5e...
Content-Type: application/json

{ "content": "¿Qué turnos tengo mañana y qué leads quedaron sin respuesta?" }
```

```json
{ "messageId": "c2a...", "runId": "r81..." }
```

Luego `GET /v1/chats/9b1.../stream?runId=r81...` y renderizar los eventos.

## Ejemplo: conectar Holded por Composio

```http
POST /v1/connections
Authorization: Bearer <sesión del dueño>
Content-Type: application/json

{ "toolkit": "holded", "owner": "workspace", "returnUrl": "https://ui.ejemplo.com/integraciones" }
```

```json
{ "connectionId": "c_31f…", "status": "INITIATED", "redirectUrl": "https://connect.composio.dev/link/ln_…" }
```

La UI abre `redirectUrl`, el dueño pega su API key de Holded en el formulario de Composio, Composio vuelve a `/v1/connections/callback?nonce=…` y el servidor emite `connection.status` con `ACTIVE`. Después:

```http
POST /v1/app-tools
{ "toolkit": "holded", "actionSlug": "HOLDED_FIND_CONTACTS", "scope": "internal", "defaultApproval": "NEVER" }
```

