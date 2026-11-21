# 10. Fundaciones (F0, 1,5 semanas)

Objetivo: repo que arranca con `docker compose up`, base de datos migrada, auth y esqueleto de API con eventos.

### T10.1. Monorepo
- **Hacer**: pnpm workspaces con el layout de `docs/08-stack-y-repo.md`; `tsconfig` base estricto; ESLint, Prettier, Vitest; scripts `typecheck`, `lint`, `test`, `dev`.
- **Hecho cuando**: `pnpm typecheck && pnpm test` pasa con un test trivial por paquete.

### T10.2. Docker
- **Hacer**: `docker/compose.dev.yml` (Postgres 16 con pgvector) y `docker/compose.yml` (server, postgres, caddy con volúmenes); `Dockerfile` multi-stage de `apps/server`; healthcheck a `/ready`.
- **Hecho cuando**: `docker compose up -d` deja `/health` respondiendo detrás de Caddy.
- **No hacer**: Kubernetes.

### T10.3. Esquema Prisma
- **Leer**: `docs/03-modelo-de-datos.md`.
- **Hacer**: `packages/db` con el esquema, `prisma.config.ts` (Prisma 7.10.x), primera migración con `CREATE EXTENSION IF NOT EXISTS vector` e índices HNSW en `KnowledgeChunk.embedding` y `Memory.embedding`; seed con un workspace, un usuario OWNER y un agente de ejemplo.
- **Hecho cuando**: `pnpm db:migrate` sobre DB vacía y `prisma validate` OK.

### T10.4. Extensión de workspace
- **Hacer**: `createScopedClient(workspaceId)` con extensión de Prisma que agrega `workspaceId` a `where` y `data` en los modelos con esa columna y lanza error si falta.
- **Hecho cuando**: test que demuestra que una query sin scope falla y una con scope no ve datos de otro workspace.

### T10.5. Fastify y Better Auth
- **Hacer**: `apps/server` con Fastify, Better Auth (email y contraseña), plugin que resuelve `request.auth = { workspaceId, actor, scopes }` desde sesión o API key; rutas `/health`, `/ready`, `/v1/me`.
- **Hecho cuando**: login, `/v1/me` con cookie y con bearer; 401 sin credencial.
- **No hacer**: registro abierto (`MULTI_TENANT=false` lo bloquea).

### T10.6. API keys
- **Hacer**: `POST/GET/DELETE /v1/api-keys`; formato `pk_<prefijo>_<secreto>`, hash SHA-256, scopes, `lastUsedAt`; guard por scope.
- **Hecho cuando**: la key se muestra una vez; revocada da 401; scope faltante da 403.

### T10.7. Eventos y WebSocket
- **Leer**: `docs/04-api-publica.md` (WS).
- **Hacer**: `packages/core/events` (`emit(workspaceId, type, data)` inserta `Event` y hace `NOTIFY`); `POST /v1/ws-tickets`; `GET /v1/ws` con `resume {afterSeq}`; `GET /v1/events?after=`.
- **Hecho cuando**: test que emite 3 eventos, desconecta, reconecta con `afterSeq` y recibe los faltantes.

### T10.8. pg-boss y roles
- **Hacer**: bootstrap de pg-boss en `apps/server/src/jobs`; `ROLE=all|api|worker`; cola `system.ping` de prueba; apagado limpio.
- **Hecho cuando**: con `ROLE=api` no se procesan jobs; con `worker` sí.

### T10.9. Contrato y errores
- **Hacer**: helper de rutas con zod que registra en OpenAPI (`/v1/openapi.json`); formato de error estándar; paginación por cursor; `Idempotency-Key` con `IdempotencyRecord`.
- **Hecho cuando**: tests de idempotencia (misma respuesta; 409 si cambia el body).

### T10.10. CI
- **Hacer**: GitHub Actions con typecheck, lint, tests (Postgres de servicio) y build de imagen.
- **Hecho cuando**: PR de prueba en verde.
