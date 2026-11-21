# src/ — capas del servidor

La estructura sigue las capas del diagrama de arquitectura v3. Cada carpeta tiene su README con responsabilidad y reglas.

| Carpeta          | Capa del diagrama                       | Contiene                                                                                           |
| ---------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `access/`        | 02 · Acceso / API                       | API Gateway (Fastify), auth (Better Auth + API keys con scopes), idempotencia, rate limit, OpenAPI |
| `orchestration/` | 03 · Orquestación e inteligencia        | Agent runtime, aprobaciones, capa LLM (memoria/RAG y orquestador multiagente: siguientes módulos)  |
| `domain/`        | 04 · Dominio / negocio                  | Agentes, contactos, conversaciones (leads, agenda, secuencias, plantillas: siguientes módulos)     |
| `integrations/`  | 05 · Integraciones                      | Registro de tools (ToolDef), tools internas, adaptadores de canal, Composio Gateway                |
| `execution/`     | 06 · Ejecución asíncrona                | Cola pg-boss (jobs), workers, bus de eventos (Event + LISTEN/NOTIFY)                               |
| `data/`          | 07 · Datos                              | Cliente Prisma 7 (generado en `data/generated/`, no se edita), auditoría, health                   |
| `shared/`        | Transversal: seguridad y observabilidad | Configuración, cifrado, errores de dominio, logs                                                   |
| `container.ts`   | —                                       | Raíz de composición: el único sitio que crea dependencias concretas                                |
| `main.ts`        | 08 · Infraestructura                    | Arranque por `ROLE` (api, worker, all)                                                             |

## Reglas de dependencia

```
access ──────────► domain, orchestration, integrations, execution(queue/bus), data, shared
orchestration ───► domain (puertos), integrations, execution(queue/bus), data, shared
integrations ────► domain (puertos), execution(queue/bus), data, shared
execution/workers ► domain, orchestration, integrations (los invoca)
domain ──────────► execution(queue/bus), data, shared        (el dominio no depende de adaptadores)
data ────────────► shared
shared ──────────► (nada del proyecto)
```

Estas reglas **se comprueban en CI** con dependency-cruiser (`pnpm lint:arch`, configuración en `.dependency-cruiser.cjs`), junto con:

- Fastify y Better Auth solo en `access/` (y la raíz de composición).
- AI SDK (`ai`, `@ai-sdk/*`) solo en `orchestration/`.
- Sin dependencias circulares.
