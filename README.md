# Everglow Agentes — motor multiagente

Motor headless 24/7 para agentes de IA de pymes: un workspace por cliente, listo para multitenant. La UI (estilo Grok Bot), las integraciones y el equipo del negocio se conectan **solo por la API pública**.

Arquitectura de referencia: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (diagrama v3, MVP · paridad Auryx).

## Stack

TypeScript · Node 22 · Fastify 5 · Prisma 7 + PostgreSQL 16 (pgvector) · pg-boss 12 · Vercel AI SDK 7 · Better Auth · zod 4 → OpenAPI 3.1 → SDK TS · Docker Compose + Caddy.

## Estructura

```
everglow-agentes/
├── apps/
│   └── server/                 Motor: API + workers (ROLE=api|worker|all)
│       ├── prisma/             Esquema y migraciones
│       ├── src/
│       │   ├── access/         02 Acceso / API: gateway, auth, idempotencia, rutas, contratos
│       │   ├── orchestration/  03 Orquestación: agent runtime, aprobaciones, capa LLM
│       │   ├── domain/         04 Dominio: agentes, contactos, conversaciones
│       │   ├── integrations/   05 Integraciones: registro de tools, canales, Composio
│       │   ├── execution/      06 Ejecución: cola pg-boss, workers, bus de eventos
│       │   ├── data/           07 Datos: cliente Prisma
│       │   ├── shared/         Seguridad y observabilidad (transversal)
│       │   ├── container.ts    Raíz de composición
│       │   └── main.ts         Arranque por ROLE
│       ├── scripts/            bootstrap (alta inicial), gen-openapi
│       └── test/               Unitarios, API, runtime y e2e contra Postgres real
├── packages/
│   └── sdk/                    SDK TS generado desde openapi.json
├── docker/                     08 Infraestructura: Dockerfile, compose, Caddy, initdb
└── docs/                       Arquitectura, decisiones, roadmap, reglas para agentes de código
```

Cada capa tiene su README en `apps/server/src/<capa>/README.md`.

## Puesta en marcha (desarrollo)

```bash
pnpm install
docker compose -f docker/compose.dev.yaml up -d          # Postgres 16 + pgvector (crea ega y ega_test)
cp .env.example apps/server/.env                          # y rellenar SECRET_KEY, BETTER_AUTH_SECRET, DATABASE_URL
cd apps/server
export $(grep -v '^#' .env | xargs)
pnpm db:generate && pnpm db:migrate
pnpm bootstrap --name "Everglow Demo" --slug demo         # imprime workspaceId y una API key (se muestra una vez)
pnpm dev                                                  # http://localhost:3000/health · /openapi.json
```

Primeros pasos con la API (sustituye `$KEY` por la API key del bootstrap):

```bash
# 1. Conexión LLM (la API key se cifra y nunca se devuelve) y prueba sin gastar tokens
curl -X POST localhost:3000/v1/connections -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"kind":"llm.openai","name":"openai-main","secret":{"apiKey":"sk-..."}}'
curl -X POST localhost:3000/v1/connections/<id>/test -H "authorization: Bearer $KEY"

# 2. Agente que usa esa conexión ("conexión:modelo")
curl -X POST localhost:3000/v1/agents -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"Recepción","instructions":"Atiende a los clientes de la clínica.","model":"openai-main:gpt-5-mini","tools":["memory.save","handoff.request"]}'

# 3. WhatsApp: Cloud API (webhook en hints.webhookUrl) o Baileys para pilotos
curl -X POST localhost:3000/v1/connections -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"kind":"channel.whatsapp_baileys","name":"wa-piloto","config":{"agentId":"<agentId>"}}'
curl -X POST localhost:3000/v1/connections/<id>/session -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"action":"start"}'
# El QR llega por WebSocket: POST /v1/ws/tickets → wss://.../v1/ws?ticket=... → {"type":"subscribe","subject":"connection:<id>"}
```

Tipos de conexión: `llm.openai`, `llm.anthropic`, `llm.google`, `llm.openai_compatible` (Ollama, LM Studio), `composio`, `channel.whatsapp_cloud`, `channel.whatsapp_baileys`.

## Calidad

```bash
pnpm check            # typecheck + ESLint + reglas de capas + Prettier + tests
pnpm openapi          # regenera openapi.json y los tipos del SDK
```

Los tests usan una base `ega_test` real (se niegan a ejecutarse contra otra) y un modelo simulado del AI SDK. Cubren: auth y scopes, aislamiento entre workspaces, idempotencia, conexiones (secretos, validación, pruebas), ciclo de aprobaciones (aprobar, rechazar, caducar, override), takeover, deduplicación, WhatsApp Cloud (firma, outbox, reintentos, ventana de 24 h, estados), sesión de Baileys, Composio con aprobación, WebSocket con tickets, orden del bus y el flujo e2e UI → cola → worker → eventos → SSE.

## Despliegue

```bash
cp .env.example .env    # rellenar
docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml exec server node dist/cli.js bootstrap --name "Mi negocio" --slug mi-negocio
```

Ver [docs/OPERATIONS.md](docs/OPERATIONS.md).
