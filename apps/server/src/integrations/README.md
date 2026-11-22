# integrations/ — Capa 05 · Integraciones

```
integrations/
  tools/
    types.ts       ToolDef: input zod, scope, riesgo, modo de aprobación, conexión requerida, preview, execute
    registry.ts    ToolRegistry: tools internas + proveedores por workspace (ToolProvider); modo de aprobación efectivo
    builtin/       Tools internas: memory.save, memory.recall, handoff.request, contact.update, kb.search (knowledge.ts)
  channels/
    adapter.ts          Interfaz ChannelAdapter, registro por tipo de conexión, canal "api", ventana de 24 h, RetryableChannelError
    whatsapp-cloud.ts   Cloud API oficial: envío, verificación de firma, parseo de webhook, tester
    whatsapp-baileys.ts Sesión por QR (solo pilotos): BaileysSessionManager, normalización, adaptador, tester
  composio/
    gateway.ts     ComposioToolProvider: acciones habilitadas por workspace → ToolDef (riesgo y aprobación inferidos o fijados)
```

## Modos de aprobación

| Modo        | Efecto                   | ¿Override del agente?                           |
| ----------- | ------------------------ | ----------------------------------------------- |
| `NEVER`     | Se ejecuta sin preguntar | Se puede endurecer a ASK_OWNER o ALWAYS         |
| `ASK_OWNER` | Pide aprobación al dueño | Se puede relajar a NEVER cuando el dueño confíe |
| `ALWAYS`    | Pide aprobación siempre  | No se puede relajar                             |

## Composio

Conexión `composio` con `config.tools: [{ slug, risk?, approval? }]`. Cada acción se expone como `composio.<slug en minúsculas>`.
Riesgo inferido por el verbo del slug (SEND → send, CREATE/UPDATE → write, GET/LIST → read; en la duda, write).
Aprobación por defecto: lecturas NEVER, escrituras y envíos ASK_OWNER, borrados ALWAYS.
Fijar `toolkitVersions` en producción para que un cambio de Composio no altere los esquemas.

## WhatsApp

- **Cloud API (producción):** webhook `/webhooks/whatsapp/<connectionId>` con firma `X-Hub-Signature-256`; la URL aparece en `hints.webhookUrl` de la conexión.
- **Baileys (pilotos):** `POST /v1/connections/:id/session {action:"start"}`; el QR llega por WebSocket (`connection:<id>`, evento `channel.qr`). Un solo worker debe ser dueño de las sesiones.
