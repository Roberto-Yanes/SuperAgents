# AGENTS.md: reglas para agentes de código (Codex, Claude Code, Kimi)

## Proyecto
Motor de Everglow para agentes autónomos: el agente recibe un objetivo, planifica y ejecuta. WhatsApp es un canal, no el producto. No lo acoples a Studio (Galatea). Los LLM de clientes europeos van en la UE. Empezá por `docs/README.md` y `docs/adr/003-runtime-agentes-autonomos.md`. La UI no está en este repo. El `user_id` de Composio que usa el código es `ega:<workspaceId>:integration`.

## Comandos
- `pnpm install`
- `docker compose -f docker/compose.dev.yml up -d` (Postgres con pgvector)
- `pnpm db:migrate` · `pnpm db:generate`
- `pnpm dev` (server con ROLE=all)
- `pnpm typecheck` · `pnpm lint` · `pnpm test`

## Reglas
1. **Una tarea por vez** (`Txx.y` de `docs/specs/`). No toques módulos fuera de su alcance.
2. **workspaceId siempre**: toda query de negocio pasa por el cliente con extensión de workspace (`packages/db`). Nunca `prisma.x.findMany()` sin workspace.
3. **Efectos externos por outbox**: enviar mensajes, crear eventos de calendario, ejecutar una acción de app (`app.*`, Composio) o mandar emails se hace con `outbox.run(key, fn)`. Nunca llamar al proveedor directo desde una tool.
4. **Tools**: definí `ToolDef` con zod (`input`, `output`), `scope`, `risk`, `defaultApproval`. Sin `any`.
5. **Reglas de negocio en código**, no en prompts.
6. **API**: cada endpoint con esquema zod, entra en OpenAPI, tiene test. Errores con códigos estables.
7. **Eventos**: todo cambio visible para la UI emite `Event` (`packages/core/events`).
8. **Secretos**: los propios (LLM, SMTP, Meta, Baileys) solo vía `packages/vault`. `COMPOSIO_API_KEY` solo en el backend. Nunca en logs, respuestas ni fixtures reales.
8b. **Apps de terceros solo por Composio** (ADR-014): prohibido agregar SDKs o clientes HTTP de Holded, Google, CRMs u otras apps. Todo pasa por `ComposioGateway` (`packages/tools/composio`): acciones del catálogo, Proxy Execute con rutas fijas o Custom MCP. El `user_id` de Composio lo arma el servidor (`ws_<workspaceId>:integration` o `ws_<workspaceId>:user_<userId>`), nunca la UI ni el modelo. En tests se usa el fake de `AppGateway`. Los canales de WhatsApp siguen siendo adaptadores nativos.
9. **Tests**: unitarios con Vitest; integración con Postgres real (Testcontainers). Proveedores externos con fakes; nada de llamadas reales en CI.
10. **Ports de Tropa**: si la tarea dice "Modo port", leé el archivo de origen en modo solo lectura, pasalo a TS estricto en funciones chicas y conservá sus casos de test.
11. **Dudas de APIs de terceros**: no inventes campos. Si no está en docs oficiales, dejá `// ⚠ VERIFICAR` y avisá.
12. Al terminar: `pnpm typecheck && pnpm test`, y resumí archivos cambiados y pendientes.

## Estilo
- TS `strict`, ESM, funciones puras donde se pueda, módulos chicos (<300 líneas).
- Nombres en inglés en código; textos para usuarios en español rioplatense.
- Fechas en UTC; convertir con `Workspace.timezone` solo para mostrar o calcular slots.
