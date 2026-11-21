# Arquitectura — Plataforma multiagente (MVP · paridad Auryx)

Versión 1.0 · 21/11/2026 · implementa el diagrama ([arquitectura-v3.png](arquitectura-v3.png)) «Plataforma Multiagente: arquitectura de referencia (MVP)», docs-v3 v1.1.

Motor headless 24/7, un workspace (listo para multitenant). La UI estilo Grok Bot es un proyecto aparte que solo habla con la API pública.

Estado de implementación marcado sobre el diagrama: [arquitectura-v3-estado.png](arquitectura-v3-estado.png) (se regenera con `python3 docs/annotate-estado.py`).

## Capas y carpetas

```mermaid
flowchart TB
  subgraph C01["01 Clientes"]
    UI["UI estilo Grok Bot"]
    INT["Integraciones por API key"]
    TEAM["Equipo del negocio"]
  end
  subgraph C02["02 Acceso / API · src/access"]
    GW["API Gateway Fastify: REST /v1, SSE, Idempotency-Key, rate limit"]
    AUTH["Auth: Better Auth + API keys con scopes"]
    OAS["OpenAPI 3.1 desde zod → packages/sdk"]
  end
  subgraph C03["03 Orquestación · src/orchestration"]
    RT["Agent runtime: tool calling con checkpoint por paso"]
    APR["Aprobaciones: NEVER · ASK_OWNER · ALWAYS, caducan solas"]
    LLM["Capa LLM: OpenAI, Anthropic, Gemini, locales"]
    MEM["Memoria y RAG (siguiente)"]
    ORC["Orquestador multiagente (post-MVP)"]
  end
  subgraph C04["04 Dominio · src/domain"]
    DOM["Agentes · Contactos · Conversaciones · Inbox y takeover"]
    DOM2["Leads · Agenda · Secuencias · Rutinas · Plantillas · Conocimiento (siguientes)"]
  end
  subgraph C05["05 Integraciones · src/integrations"]
    TR["Registro de tools: ToolDef zod con scope, riesgo, aprobación"]
    CH["Adaptadores de canal: interfaz ChannelAdapter"]
    CG["Composio Gateway (siguiente)"]
  end
  subgraph C06["06 Ejecución · src/execution"]
    Q["Cola pg-boss 12: run.process (serializada por conversación), channel.inbound, message.outbound, run.sweep..."]
    BUS["Bus de eventos: tabla Event con seq + LISTEN/NOTIFY"]
  end
  subgraph C07["07 Datos · src/data + prisma/"]
    PG[("PostgreSQL 16 + pgvector · Prisma 7 · workspaceId en toda entidad")]
  end
  UI --> GW
  INT --> GW
  TEAM --> GW
  GW --> AUTH
  GW --> DOM
  GW --> Q
  Q --> RT
  RT --> LLM
  RT --> TR
  RT --> APR
  RT --> BUS
  BUS --> GW
  CH --> Q
  DOM --> PG
  Q --> PG
  BUS --> PG
```

| Capa del diagrama          | Carpeta                                           | Estado                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 Clientes                | proyecto aparte; `packages/sdk`                   | SDK generado                                                                                                                                                                                                                                                  |
| 02 Acceso / API            | `apps/server/src/access`                          | Hecho: REST /v1 (incl. /v1/me, /v1/tools, /v1/events, listado y cancelación de runs), SSE con ticket, WebSocket, auth (alta cerrada + CLI, API keys con scopes), idempotencia global, rate limit por principal, OpenAPI 3.1, conexiones, webhooks de WhatsApp |
| 03 Orquestación            | `apps/server/src/orchestration`                   | Hecho: runtime con caras interna/externa, aprobaciones con estados EXECUTING/UNKNOWN, cancelación, barrido de huérfanos, capa LLM. Pendiente: memoria con pgvector/RAG, orquestador                                                                           |
| 04 Dominio                 | `apps/server/src/domain`                          | Hecho: agentes, conexiones (catálogo por tipo), contactos, conversaciones, takeover. Pendiente: leads, agenda, secuencias, rutinas, plantillas, conocimiento                                                                                                  |
| 05 Integraciones           | `apps/server/src/integrations`                    | Hecho: registro de tools (internas + Composio por workspace), WhatsApp Cloud API y Baileys, canal `api`. Pendiente: email, Instagram                                                                                                                          |
| 06 Ejecución               | `apps/server/src/execution`                       | Hecho: cola con todos los nombres del diagrama, run.process serializado por conversación, barrido, outbound con estados SENDING/UNKNOWN, sesiones de canal y caducidad; bus ordenado con reconexión                                                           |
| 07 Datos                   | `apps/server/src/data`, `apps/server/prisma`      | Hecho: esquema base y migraciones                                                                                                                                                                                                                             |
| 08 Infraestructura         | `docker/`                                         | Hecho: imagen única, compose (server ROLE=all, postgres+pgvector, caddy, ollama opcional)                                                                                                                                                                     |
| Auditoría y observabilidad | `apps/server/src/shared/observability`            | Hecho: logs pino con redacción, AuditLog, /health, /ready, uso de tokens por run. Pendiente: métricas y costes                                                                                                                                                |
| Seguridad                  | `apps/server/src/shared/security` + `access/auth` | Hecho: AES-256-GCM con AAD y CLI de rotación, sesión de Baileys cifrada, guarda multi-tenant, política de baseURL, claves hasheadas, scopes, firma de webhooks de Meta. Pendiente: firma de webhooks de Composio                                              |

## Flujo «Chat desde la UI» (A → E)

```mermaid
sequenceDiagram
  participant UI as UI / SDK
  participant API as API Gateway
  participant DB as PostgreSQL
  participant Q as pg-boss
  participant W as Worker + runtime
  participant LLM as Capa LLM
  UI->>API: A · POST /v1/chats/:id/messages (Idempotency-Key)
  API->>DB: Message INBOUND + Run QUEUED (misma transacción)
  API->>Q: B · run.process (grupo = conversación)
  API-->>UI: 202 { runId }
  UI->>API: GET /v1/runs/:id/events (SSE)
  Q->>W: C · el worker toma el run (QUEUED → RUNNING)
  W->>LLM: streamText con tools
  W->>DB: D · Event message.delta (trigger NOTIFY)
  DB-->>API: NOTIFY ega_events
  API-->>UI: E · event: message.delta
  W->>DB: checkpoint por paso, Message OUTBOUND, run.finished
  API-->>UI: event: run.finished
```

## Flujo «WhatsApp entrante» (1 → 6)

```mermaid
sequenceDiagram
  participant META as Meta / WhatsApp
  participant AD as Adaptador de canal
  participant Q as pg-boss
  participant W as Worker
  participant RT as Runtime
  META->>AD: 1 · mensaje por socket (Baileys) o webhook (Cloud API)
  AD->>Q: 2 · channel.inbound (normalizado)
  Q->>W: contacto + conversación + dedupe por wamid
  W->>Q: run.process (si no hay takeover)
  Q->>RT: 3 · el worker inicia el run
  RT->>RT: 4 · tool calling con el LLM
  RT->>Q: 5 · respuesta al outbox: message.outbound
  Q->>AD: 6 · envío al contacto (ventana de 24 h)
```

## Aprobaciones

```mermaid
stateDiagram-v2
  [*] --> PENDING: el modelo llama a una tool ASK_OWNER o ALWAYS
  PENDING --> APPROVED: dueño aprueba
  PENDING --> REJECTED: dueño rechaza
  PENDING --> EXPIRED: vence (approvals.expire cada 5 min)
  APPROVED --> EXECUTED: run.resume ejecuta una vez con idempotencyKey
  APPROVED --> FAILED: la tool devuelve error
  EXECUTED --> [*]
  FAILED --> [*]
  REJECTED --> [*]
  EXPIRED --> [*]
```

Mecánica: las tools que requieren aprobación se entregan al modelo sin `execute`. El AI SDK ejecuta las automáticas del mismo paso y se detiene dejando la llamada pendiente. El runtime guarda la `Approval` y el checkpoint y pone el run en `WAITING_APPROVAL`. Al decidirse la última pendiente se encola `run.resume`: se ejecuta lo aprobado (o se informa del rechazo o la caducidad), se añade el `tool-result` al historial y el bucle continúa. Un mismo run puede pausar varias veces.

## Modelo de datos (resumen)

`Workspace` · `Membership` (OWNER, ADMIN, OPERATOR) · `ApiKey` (hash + scopes) · `Connection` (secretos cifrados: LLM, Composio, canales) · `Agent` (instrucciones, modelo `conexión:modelo`, tools y overrides, versión) · `Contact` · `Conversation` (canal, takeover, `lastInboundAt`) · `Message` (dedupe por `channelMessageId`, estado de outbox) · `Run` (estado, checkpoint, uso) · `RunStep` · `Approval` · `Memory` · `Routine` · `Event` (seq global) · `IdempotencyRecord` · `AuditLog` · tablas de Better Auth. Detalle en `apps/server/prisma/schema.prisma`.

## Calidad

`pnpm check` = typecheck + ESLint + reglas de capas (dependency-cruiser) + Prettier + tests contra Postgres. Se ejecuta en CI junto con la comprobación de que el OpenAPI y el SDK están al día. Ver `docs/DECISIONS.md` D-012.

## Garantías

| Garantía                         | Cómo                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Aislamiento por workspace        | `workspaceId` sale del `Principal`; todas las consultas lo filtran; tests de cruce |
| Un mensaje, un run               | Dedupe por `channelMessageId` + `@@unique`; Idempotency-Key en la API              |
| Un run lo ejecuta un solo worker | Transición condicionada `QUEUED → RUNNING` / `WAITING_APPROVAL → RUNNING`          |
| Lo aprobado se ejecuta una vez   | Transición atómica de la aprobación + `idempotencyKey` pasada a la tool            |
| Reanudar tras caída              | Checkpoint del historial en cada paso; un reintento de la cola retoma desde ahí    |
| Streaming sin pérdidas           | Eventos persistidos con `seq`; SSE con backlog + `Last-Event-ID`                   |
| Humano al mando                  | Takeover y HANDOFF detienen al agente; las aprobaciones caducan solas              |
