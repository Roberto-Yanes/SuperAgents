# access/ — Capa 02 · Acceso / API

Única puerta de entrada al motor. La UI estilo Grok Bot, las integraciones y el equipo del negocio hablan solo con esta API.

```
access/
  auth/
    better-auth.ts        Sesiones de usuario (UI) con Better Auth + Prisma
    api-keys.ts           ApiKeyService: emitir (sin escalar privilegios), listar, revocar, verificar
    principal-resolver.ts Quién llama: API key o sesión + X-Workspace-Id
    scopes.ts             Catálogo de scopes, scopes por rol, Principal, actorFrom()
  realtime/
    tickets.ts            Tickets de un solo uso para el WebSocket
  http/
    app.ts                Gateway Fastify: OpenAPI 3.1, CORS, rate limit, errores, registro de rutas
    errors.ts             Traducción DomainError → HTTP y errores propios del protocolo
    schemas.ts            Contratos zod de la API pública (fuente del OpenAPI y del SDK)
    plugins/
      auth.ts             Resuelve el Principal en cada petición; requireScopes()
      idempotency.ts      Idempotency-Key en POST con efectos (cuerpos binarios: por sha256)
    routes/               Un archivo por recurso: health, metrics, agents, chats, conversations,
                          contacts, agenda, leads, routines, sequences, runs (+SSE), approvals,
                          api-keys, connections (+session), ws (tickets + /v1/ws), webhooks (WhatsApp),
                          tasks, workspace, files (cuerpo binario), knowledge, templates, privacy, usage
```

Reglas:

- El `workspaceId` sale siempre del `Principal` (o, en webhooks, de la conexión verificada por firma).
- Las rutas validan, autorizan y delegan en servicios: **no acceden a Prisma**.
- Cada ruta declara sus dependencias con un tipo `XDeps = Pick<AppContext, ...>`: recibe solo lo que usa.
