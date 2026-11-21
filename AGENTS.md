# AGENTS.md — reglas para agentes de código (Claude Code, Codex)

## Qué es

Motor multiagente headless de Everglow. Arquitectura en `docs/ARCHITECTURE.md`; una carpeta por capa en `apps/server/src/` (cada una con su README).

## Stack

TypeScript 5.9 (ESM, NodeNext), Node 22, pnpm, Fastify 5 + fastify-type-provider-zod, zod 4, Prisma 7.10.1 (`@prisma/adapter-pg`), PostgreSQL 16, pg-boss 12, Vercel AI SDK 7, Better Auth, pino, Vitest.

## Reglas no negociables

1. **workspaceId del Principal.** Toda consulta de datos de negocio filtra por `workspaceId` obtenido de `principalOf(req)` (API) o del job/run (workers). Nunca del cuerpo ni de la URL.
2. **Respetar las capas.** Ver «Reglas de dependencia» en `apps/server/src/README.md`; `pnpm lint:arch` las comprueba. Las rutas no usan Prisma: delegan en servicios. Cada ruta o worker declara sus dependencias con `Pick<AppContext, ...>`. El dominio lanza `DomainError`, nunca códigos HTTP.
3. **Tools solo vía ToolDef.** Toda acción del agente es un `ToolDef` registrado, con `scope`, `risk` y `approval`. Nada de llamar APIs externas desde el runtime directamente.
4. **Escrituras externas idempotentes.** Las tools usan `ctx.idempotencyKey`. Los workers comprueban el estado en base de datos antes de actuar.
5. **Secretos** cifrados en `Connection.secretEnc` (`shared/security/crypto.ts`). Nunca en logs, eventos, respuestas, prompts ni fixtures.
6. **Contratos con zod** en `access/http/schemas.ts`. Si cambia la API: `pnpm openapi` y commit del `openapi.json` y del SDK regenerado.
7. **Migraciones aditivas** con `prisma migrate dev --name <cambio>` (sin TTY: `migrate diff` + `migrate deploy`, ver `docs/OPERATIONS.md`). No editar migraciones ya aplicadas. No ejecutar `migrate reset` ni comandos destructivos.
8. **Tests** en cada cambio, contra la base `ega_test`. El LLM se simula con `scriptedModel()` de `test/helpers.ts`.
9. **Sin dependencias nuevas** sin justificarlas en el PR.
10. **Robustez (D-017):** ningún `await` sin capturar en listeners (WS, Baileys, EventEmitter); validar UUID con `isUuid` antes de consultar; encolar runs solo con `enqueueRun()`; nada de `singletonKey`; toda acción con efectos se toma con una transición condicionada antes de ejecutarse y, si se corta, queda `UNKNOWN` (nunca se repite sola).
11. **Caras de las tools (D-017):** una tool nueva es `exposure: "internal"` salvo que deba estar al alcance de contactos externos; justificar cualquier `"external"` con efectos.

## Comandos

```bash
pnpm check                          # typecheck + lint + reglas de capas + formato + tests
pnpm --filter @ega/server dev       # servidor con recarga
pnpm openapi                        # regenerar contrato y SDK
```

## Cómo añadir un módulo de dominio (patrón)

1. Modelo en `prisma/schema.prisma` con `workspaceId` + migración.
2. `src/domain/<modulo>/service.ts` (sin HTTP).
3. Esquemas en `access/http/schemas.ts` y rutas en `access/http/routes/<modulo>.ts` con `requireScopes(...)`.
4. Si hay trabajo asíncrono: job en `execution/queue/jobs.ts` y worker en `execution/workers/`.
5. Si el agente lo usa: `ToolDef` en `integrations/tools/`.
6. Tests: servicio, aislamiento por workspace y ruta.
7. Actualizar el README de la capa y `docs/ROADMAP.md`.

## Estilo

Código y commits en inglés; textos de cara al usuario y documentación en español. Commits: `feat(domain): ...`, `fix(runtime): ...`.
