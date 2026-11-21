# 05. Flujos clave

## 1. WhatsApp entrante → respuesta del agente

```mermaid
sequenceDiagram
  participant C as Cliente
  participant WA as WhatsApp (Baileys o Cloud API)
  participant AD as ChannelAdapter
  participant DB as Postgres
  participant Q as pg-boss
  participant W as Worker
  participant RT as Agent runtime
  participant LLM as LLM
  participant CG as Composio Gateway
  C->>WA: Hola, quiero un turno mañana
  WA->>AD: evento (socket Baileys o webhook firmado)
  AD->>DB: upsert Contact e identidad, Message RECEIVED (unique externalId)
  AD->>Q: send channel.inbound con singletonKey = externalId
  Q->>W: channel.inbound
  W->>DB: conversación, ¿takeover humano? ¿fuera de horario?
  alt conversación en manos de un humano
    W-->>DB: solo evento message.created para el inbox
  else agente atiende
    W->>Q: run.execute (grupo por conversación, 1 a la vez)
    Q->>RT: run.execute
    RT->>LLM: contexto + tools externas
    LLM-->>RT: tool call calendar.check_availability
    RT->>CG: GOOGLECALENDAR_FIND_FREE_SLOTS (cuenta del negocio)
    CG-->>RT: ocupado y libre, slots calculados en código
    RT->>DB: RunStep TOOL_CALL y resultado (checkpoint)
    RT->>LLM: resultado de la tool
    LLM-->>RT: texto de respuesta
    RT->>DB: OutboundSend PENDING (idempotencyKey = runId + paso)
    RT->>AD: send
    AD->>WA: mensaje
    AD->>DB: OutboundSend SENT, Message SENT con externalId
  end
  WA-->>AD: estados delivered y read
  AD->>DB: Message status
```

## 2. Delegación entre agentes (equipo)

```mermaid
sequenceDiagram
  participant U as Dueño (UI)
  participant API as API
  participant CO as Coordinador
  participant OR as Orquestador
  participant VE as Agente Ventas
  participant AG as Agente Agenda
  U->>API: POST /chats/:id/messages "Armá campaña para leads fríos y reservá una reunión"
  API->>CO: run USER_CHAT
  CO->>OR: tool team.delegate_task(Ventas, "listar leads fríos y redactar mensaje")
  OR->>OR: valida permisos del equipo y profundidad máxima
  OR->>VE: Task hija + run DELEGATION
  CO-->>CO: run en WAITING_CHILD
  VE-->>OR: resultado (lista y borrador)
  OR->>CO: reanuda con el resultado
  CO->>OR: tool team.delegate_task(Agenda, "reunión de revisión el jueves")
  OR->>AG: Task hija
  AG-->>OR: turno reservado
  OR->>CO: reanuda
  CO-->>API: respuesta final por streaming
  API-->>U: eventos delegation, message.delta, run.finished
```

`team.handoff_to_agent` es distinto: transfiere **la conversación** (por ejemplo, de Recepción a Ventas en WhatsApp) y el agente original deja de responder en ella.

## 3. Secuencia de seguimiento

```mermaid
sequenceDiagram
  participant T as Disparador (agente, rutina o API)
  participant S as Servicio de secuencias
  participant Q as pg-boss
  participant W as Worker
  participant CH as Canal
  participant C as Contacto
  T->>S: enroll(contacto, secuencia)
  S->>Q: sequence.step con startAfter = ahora + delay del paso 1
  Q->>W: sequence.step
  W->>W: ¿opt-out? ¿respondió? ¿enrollment activo?
  alt el contacto respondió o se dio de baja
    W->>S: STOPPED con motivo
  else continuar
    W->>W: contenido: plantilla, texto fijo o borrador IA
    opt paso con aprobación
      W->>W: Approval PENDING y espera
    end
    W->>CH: envío con idempotencyKey = enrollmentId + paso
    CH->>C: mensaje (fuera de 24 h: solo plantilla en Cloud API)
    W->>Q: siguiente paso con startAfter
  end
  C-->>CH: responde
  CH->>S: evento message.created de contacto inscripto
  S->>S: stopOnReply: STOPPED
```

## 4. Aprobación

```mermaid
sequenceDiagram
  participant RT as Runtime
  participant DB as Postgres
  participant BUS as Eventos
  participant UI as UI o móvil
  participant Q as pg-boss
  RT->>RT: tool email.send con política ASK_OWNER
  RT->>DB: RunStep PENDING, Approval PENDING con expiresAt
  RT->>DB: Run WAITING_APPROVAL
  RT->>BUS: approval.requested
  BUS-->>UI: WS approval.requested
  UI->>DB: POST /approvals/:id/decide approve (opcional editedPayload)
  DB->>Q: run.resume con singletonKey = approvalId
  Q->>RT: run.resume
  RT->>RT: ejecuta la tool con el payload aprobado
  RT->>DB: RunStep DONE, Run RUNNING, sigue el loop
  Note over RT,Q: Si vence, approval.expire marca EXPIRED y el LLM recibe "acción rechazada por vencimiento"
```

## 5. UI chateando con un agente (streaming)

```mermaid
sequenceDiagram
  participant UI as UI estilo Grok Bot
  participant API as API Gateway
  participant Q as pg-boss
  participant RT as Runtime
  participant BUS as Bus de eventos
  UI->>API: POST /v1/ws-tickets y abre WS
  UI->>API: POST /v1/chats/:id/messages con Idempotency-Key
  API->>API: guarda Message USER, crea Run QUEUED
  API->>Q: run.execute
  API-->>UI: 202 messageId y runId
  UI->>API: GET /v1/chats/:id/stream?runId (SSE) o subscribe por WS
  Q->>RT: run.execute
  loop tokens y tools
    RT->>BUS: message.delta, tool.started, tool.finished
    BUS-->>API: LISTEN/NOTIFY
    API-->>UI: eventos
  end
  RT->>BUS: message.completed, run.finished
  API-->>UI: fin del stream
```

## 6. Conectar una app por Composio (Holded o Google Calendar)

```mermaid
sequenceDiagram
  participant UI as UI (dueño)
  participant API as API Gateway
  participant CG as Composio Gateway
  participant CO as Composio
  participant DB as Postgres
  UI->>API: POST /v1/connections {toolkit, owner}
  API->>CG: userId = ws_<id>:integration
  CG->>CO: connectedAccounts.link(userId, authConfig, callbackUrl con nonce)
  CO-->>CG: redirectUrl + id del connected account
  CG->>DB: Connection INITIATED
  API-->>UI: redirectUrl
  UI->>CO: el dueño autoriza (OAuth de Google o API key de Holded en el formulario de Composio)
  CO-->>API: GET /v1/connections/callback?nonce=…
  API->>CO: connectedAccounts.get(id): estado ACTIVE y user_id
  API->>DB: Connection ACTIVE, accountRef
  API-->>UI: redirige a returnUrl y emite connection.status
```

## 7. Tool de app ejecutada por un agente (con aprobación)

```mermaid
sequenceDiagram
  participant RT as Runtime
  participant TR as Registro de tools
  participant AP as Aprobaciones
  participant OB as Outbox
  participant CG as Composio Gateway
  participant CO as Composio
  RT->>TR: app.holded.create_contact {…}
  TR->>TR: ¿cara permitida? ¿conexión ACTIVE? política ASK_OWNER
  TR->>AP: Approval PENDING (el run pausa)
  AP-->>TR: aprobada por el dueño (el run se reanuda)
  TR->>OB: OutboundSend kind=app (idempotencyKey = runId + paso)
  OB->>CG: execute HOLDED_CREATE_CONTACT con versión fijada
  CG->>CO: session.execute(slug, args) como ws_<id>:integration
  CO-->>CG: {successful, data}
  CG-->>OB: SENT + externalId (o FAILED retryable/fatal)
  OB-->>RT: resultado de la tool
```

## 8. Trigger de Composio (email nuevo en Gmail)

```mermaid
sequenceDiagram
  participant G as Gmail
  participant CO as Composio
  participant API as POST /v1/webhooks/composio
  participant Q as pg-boss
  participant W as Worker
  G->>CO: mensaje nuevo (push en tiempo real)
  CO->>API: evento GMAIL_NEW_GMAIL_MESSAGE firmado
  API->>API: triggers.verifyWebhook, mapea ti_* a ConnectionTrigger y workspace
  API->>Q: integration.event (singletonKey = id del evento)
  API-->>CO: 200
  Q->>W: integration.event
  alt target = CHANNEL (canal COMPOSIO_EMAIL)
    W->>W: normaliza como mensaje entrante y sigue el flujo 1
  else target = ROUTINE
    W->>W: crea Task de la rutina con el payload
  end
```

## Estados de un run

```mermaid
stateDiagram-v2
  [*] --> QUEUED
  QUEUED --> RUNNING
  RUNNING --> WAITING_APPROVAL
  WAITING_APPROVAL --> RUNNING: aprobada o rechazada
  RUNNING --> WAITING_CHILD
  WAITING_CHILD --> RUNNING: subtarea terminada
  RUNNING --> COMPLETED
  RUNNING --> FAILED
  QUEUED --> CANCELLED
  RUNNING --> CANCELLED
  WAITING_APPROVAL --> CANCELLED
  COMPLETED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]
```
