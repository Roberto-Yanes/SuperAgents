# 08. Stack, repo y reutilización

## Stack (versiones vistas en npm el 21/11/2026)

| Capa | Elección | Versión | Por qué |
|---|---|---|---|
| Lenguaje y runtime | TypeScript estricto, Node.js 22.12+ (recomendado 24 LTS) | — | Un lenguaje en todo; pg-boss exige Node ≥22.12 |
| Monorepo | pnpm workspaces | — | Simple |
| HTTP, WS, SSE | Fastify + `@fastify/websocket` | 5.12.x / 11.3.x | Rápido, esquemas, plugins |
| Validación y contrato | zod 4 + generación OpenAPI | 4.6.x | Un esquema para validar, tipar y documentar ⚠ VERIFICAR librería zod→OpenAPI compatible con zod 4 |
| DB | PostgreSQL 16+ con pgvector | — | Una sola dependencia: datos, cola, eventos, vectores |
| ORM | Prisma | **7.10.x** (no 8.0-rc) | Esquema legible para agentes de código |
| Cola y scheduler | pg-boss | 12.x | Sobre Postgres; reintentos, cron, `startAfter`, grupos con concurrencia |
| Auth | Better Auth | 1.7.x | Sesiones, email y contraseña, integración Fastify |
| LLM | Vercel AI SDK (`ai`) + `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`; Ollama vía `ollama-ai-provider-v2` o endpoint compatible OpenAI; LM Studio vía compatible OpenAI | 7.0.x / 4.0.x | Tool calling y streaming uniformes entre proveedores ⚠ VERIFICAR API exacta de la v7 al implementar |
| WhatsApp no oficial | Baileys | 7.0.0-rc14 (la que usa Tropa) | Adaptador `BAILEYS` |
| WhatsApp oficial | Graph API por `fetch` | — | Adaptador `META_CLOUD` (datos verificados en docs-v2: ventana de 24 h, plantillas, Embedded Signup v4) |
| Apps de terceros | Composio: `@composio/core` (SDK TypeScript, API REST v3.1) | 0.31.x | Capa única de conectores (ADR-014): catálogo, Connect Link, connected accounts, ejecución de acciones, triggers. No se usa su provider de framework: el gateway arma `ToolDef` propios ⚠ VERIFICAR firmas de `create`/`execute` en la referencia de la versión instalada |
| Email | nodemailer (SMTP) | 10.x | Canal `SMTP` nativo; Gmail u Outlook van por Composio |
| Logs | pino | 10.x | JSON, redacción |
| Tests | Vitest + Testcontainers (Postgres) | — | ⚠ VERIFICAR imagen pgvector para tests |
| Despliegue | Docker Compose (server, postgres, caddy) | — | VPS, PC o mini PC |

## Layout del repo

```text
plataforma/
  apps/
    server/                 # proceso único (ROLE=all|api|worker)
      src/api/              # rutas REST, WS, SSE, OpenAPI
      src/auth/             # Better Auth, API keys, tickets WS
      src/jobs/             # registro de colas pg-boss y handlers
      src/webhooks/         # Meta, Composio, rutinas
      src/main.ts
  packages/
    db/                     # Prisma schema, migraciones, cliente con extensión de workspace
    core/
      runtime/              # loop de agente, contexto, checkpoints
      orchestrator/         # equipos, handoff, delegate
      approvals/
      memory/               # memoria y RAG
      inbox/                # contactos, conversaciones, leads, takeover
      events/               # Event + LISTEN/NOTIFY
      audit/
      outbox/               # OutboundSend
    llm/                    # proveedores y precios por modelo
    tools/                  # ToolDef, registro y tools built-in
      composio/             # ComposioGateway: catálogo, conexiones, AppTool → ToolDef, execute, triggers, proxy
    vault/                  # secretos propios (LLM, SMTP, Meta, Baileys); nada de apps de terceros
    channels/               # ChannelAdapter, whatsapp-baileys, whatsapp-cloud, email, instagram
    templates/              # plantillas por rubro (JSON + prompts)
    sdk/                    # cliente TS de la API pública (para la UI)
    executors/              # (post-MVP) device y sandbox
  docker/                   # compose, Caddyfile, Dockerfile
  docs/                     # este paquete
  AGENTS.md  CLAUDE.md
```

## Qué se porta de Tropa v2 (`/workspace/tropa-desktop-src/`, Apache-2.0)

| Archivo de Tropa | Destino | Qué se toma |
|---|---|---|
| `channels/transport-baileys.mjs` | `packages/channels/whatsapp-baileys/transport.ts` | Arranque con `useMultiFileAuthState`, QR y código de vinculación, reconexión por generación, clasificación de mensajes (`messageKind`), permisos 0700 |
| `channels/whatsapp.mjs` | `packages/channels/whatsapp-baileys/` y `packages/channels/common/` | `splitText` (partir a 3500 y pasar Markdown a formato WhatsApp), cola de envío con rate limit (1 s entre mensajes, 20 por minuto), deduplicación, reconocimiento por JID o LID, agrupado de mensajes viejos |
| `channels/whatsapp-service.mjs` | `packages/channels/whatsapp-baileys/service.ts` | Ciclo de vida link/unlink, estado, máscara del número |
| `engine.mjs` (`collaborate`, `parseDecision`, reglas de contactos) | `packages/core/orchestrator` | Reglas de quién puede consultar a quién, límite de consultas por mensaje, pila de delegación; se reescribe con tools |
| `engine.mjs` (`createAgentFromChat`, `createTeamFromChat`) | tools internas `agents.create`, `teams.create` (post-MVP inmediato) | Crear agentes desde el chat |
| `flows.mjs` | `packages/core/routines` | Nodos condición (regla o IA, `conditionResult`) y aprobación para rutinas avanzadas |
| `operations.mjs` | `packages/core/routines` | Semántica de programaciones: no superponer, condensar vencidas |
| `local-providers.mjs` | `packages/llm/local` | Detección de modelos de Ollama (`/api/tags`) y LM Studio (`/v1/models`), validación del modelo, límite de tool calls por turno, detección de "dice que creó un archivo y no lo hizo" |
| `openai-eu.mjs` | `packages/llm` | Endpoint UE de OpenAI como opción de región |
| `document-mcp.mjs` | tool `docs.generate` | PDF, DOCX y XLSX con pdfkit, docx, exceljs |
| `files.mjs`, `local-tools.mjs` | `packages/core/files` | Rutas seguras, sin symlinks, límites de tamaño |
| `mobile/store.mjs` (`mobile_requests`) | `IdempotencyRecord` | Patrón de idempotencia por cliente |
| `protocol/crypto.mjs`, `relay/server.mjs` | `packages/executors/device` (post-MVP) | Identidades Ed25519/X25519, nonce firmado, `ReplayGuard`, para el runtime local |
| `browser-service.mjs`, `site-policy.mjs` | `packages/executors/device` (post-MVP) | Navegador con aprobación por acción y listas de sitios |
| `test/whatsapp-channel.test.mjs`, `test/whatsapp-transport.test.mjs`, `test/flows.test.mjs` | tests equivalentes | Casos a conservar |

**No se porta**: `server.mjs` (servidor HTTP manual), la persistencia JSON de `engine.mjs`, `providers.mjs` (CLI con suscripciones), `public/` (la UI es otro proyecto), vaults en Python, `google-connectors.mjs` (Google pasa por Composio).

## Qué se toma de docs-v2

| docs-v2 | Uso en docs-v3 |
|---|---|
| Datos verificados de Meta (ventana de 24 h, plantillas, Embedded Signup v4, Tech Provider, firma) en `12-conexiones-y-whatsapp.md` | Spec 14 (adaptador Cloud API) |
| `13-agenda-calendar.md` (slots puros, freeBusy) | Spec 17: se conserva el cálculo de slots; el acceso a Google pasa a Composio |
| `14-leads-y-holded.md` (embudo, reglas de etapa) | Spec 18: se conserva el embudo; el cliente Holded se reemplaza por Composio (acciones + Proxy Execute) |
| `15-seguimientos-y-rutinas.md` | Spec 19 |
| `16-plantillas-de-agente.md` | Spec 22 |
| `03-conceptos-del-agente.md` (caras, tools, aprobaciones) | Doc 02 |
| `04-protocolo-runtime-local.md` y la sección `CLOUD_SANDBOX` (OpenSandbox) | Spec 30 (ejecutores enchufables) |
| ADR-011 (reglas en código), ADR-012 (LISTEN/NOTIFY), ADR-013 (OpenSandbox) | Se mantienen |
