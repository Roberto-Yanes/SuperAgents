# 16. Composio Gateway y vault propio (F2)

Decisión: ADR-014. Toda app de terceros entra por Composio; acá no se escribe ningún cliente por app.

Referencias, todas vistas el 21/11/2026:
- [Conceptos y sesiones](https://docs.composio.dev/docs/how-composio-works)
- [Autenticación](https://docs.composio.dev/docs/authentication)
- [Agentes B2B y `user_id`](https://docs.composio.dev/docs/b2b-agents)
- [White-label](https://docs.composio.dev/docs/authentication/white-labeling-authentication)
- [Triggers](https://docs.composio.dev/docs/triggers)
- [Proxy Execute](https://docs.composio.dev/docs/extending-sessions/proxy-execute)
- [Custom MCP](https://docs.composio.dev/docs/extending-sessions/custom-mcp)
- [Límites](https://docs.composio.dev/reference/rate-limits)
- [Custodia de tokens](https://docs.composio.dev/docs/security/token-custody)

SDK: `@composio/core` 0.31.x, API REST v3.1.

### T16.1. Vault propio (solo lo que no es de Composio)
- **Hacer**: `packages/vault`: `put(workspaceId, json) → secretId`, `get(secretId)`, `rotate()` con AES-256-GCM y `MASTER_KEY`; redacción en logs. Lo usan `Credential` (LLM_*, SMTP) y `Channel` (token de Meta Cloud API, sesión de Baileys).
- **Hecho cuando**: tests de cifrado, clave incorrecta y rotación. Ningún dato de Holded, Google ni otra app pasa por acá.

### T16.2. Credenciales propias
- **Hacer**: `/v1/credentials` (alta, prueba con una llamada barata, baja) para LLM_* y SMTP.
- **Hecho cuando**: tests con fakes; la respuesta nunca incluye el secreto.

### T16.3. Cliente y configuración de Composio
- **Hacer**: `packages/tools/composio/client.ts` con `new Composio({ apiKey: env.COMPOSIO_API_KEY })`, solo en el backend.
  - Un proyecto de Composio por entorno.
  - `composioUserId(workspaceId, owner, userId?)` → `ws_<workspaceId>:integration` o `ws_<workspaceId>:user_<userId>`.
  - Interfaz `AppGateway` (listToolkits, link, getAccount, deleteAccount, listActions, execute, proxy, createTrigger, verifyWebhook) para poder cambiar de proveedor.
  - Auth administrada por Composio por defecto. `auth_config_id` propio opcional por toolkit (white-label o scopes propios) en `Workspace.settings.composio.authConfigs`.
- **Hecho cuando**: tests con un fake de `AppGateway`. La key no aparece en logs ni respuestas (test de redacción).

### T16.4. Catálogo y conexiones
- **Hacer**:
  - `GET /v1/connections/toolkits` (cache de 1 h) y `GET /v1/connections/toolkits/:slug/actions`.
  - `POST /v1/connections` → `connectedAccounts.link(userId, authConfigId, { callbackUrl })`, que crea la `Connection` en `INITIATED` con `linkNonce` y el ID del connected account.
  - `GET /v1/connections/callback`: lee el connected account desde Composio y valida `user_id` e ID contra lo guardado. Nunca confía en la query.
  - `reconnect`, `DELETE` (borra en Composio), `connection.status` por WS.
  - Toolkits con API key (Holded) usan el mismo Connect Link, con el formulario hospedado por Composio ⚠ VERIFICAR que el Connect Link pida la API key de toolkits `API_KEY`; si no, alta con `connectedAccounts.initiate` desde el backend, sin persistir la key.
- **Hecho cuando**:
  - Tests con fake: callback con nonce desconocido → 400; callback con `user_id` de otro workspace → 403.
  - Prueba manual con Google Calendar (OAuth) y Holded (API key).

### T16.5. Acciones como tools (`AppTool` → `ToolDef`)
- **Hacer**:
  - `POST /v1/app-tools` habilita una acción: guarda `toolkitVersion` fijada, snapshot de `inputSchema`, `scope` (default `internal`), `risk` inferido del slug (`GET`, `FIND`, `LIST`, `FETCH` → read; `DELETE` → delete; resto → write; editable) y `defaultApproval` (read `NEVER`, write `ASK_OWNER`, delete `ALWAYS`).
  - El registro publica `app.<toolkit>.<acción>` como `ToolDef` con `requires.toolkit`. Lo oculta si no hay `Connection` `ACTIVE` y lo informa en `GET /v1/tools` (`missingConnection`).
  - `execute`: sesión de Composio con preset de tools directas y meta tools apagadas, para el `user_id` y el connected account elegidos; `session.execute(slug, args)`. Las escrituras van envueltas en `outbox.run`.
  - Resultado `{ successful, data, error }` → éxito, `retryable` (429, 5xx, timeout) o `fatal`.
  - Tamaño máximo del resultado que vuelve al LLM; el resto queda en `RunStep`.
- **Hecho cuando**:
  - Test: una acción `DELETE` nace con `ALWAYS`.
  - Test: una tool `app.*` no aparece en la cara externa salvo `scope: external`.
  - Test: un reintento con la misma clave no ejecuta dos veces.

### T16.6. Triggers y ciclo de vida
- **Hacer**:
  - `POST /v1/webhooks/composio` verifica la firma con `composio.triggers.verifyWebhook()` y `COMPOSIO_WEBHOOK_SECRET`.
  - Mapea `ti_*` → `ConnectionTrigger` → workspace y encola `integration.event` con `singletonKey` = ID del evento. Responde 200 rápido.
  - Eventos de ciclo de vida (cuenta vencida) → `NEEDS_REAUTH`.
  - `POST /v1/connections/:id/triggers` crea el trigger en Composio.
- **Hecho cuando**: tests con payloads firmados y con firma inválida; un evento repetido se procesa una vez.

### T16.7. Fuera de catálogo (escape dentro de Composio)
- **Hacer**:
  - `gateway.proxy(connection, { method, path, body })` (Proxy Execute) solo para tools nativas con rutas fijas en código. Primer uso: leads del CRM de Holded (spec 18).
  - Documentar cómo registrar un Custom MCP (`composio.customToolkits.create`), p. ej. el MCP oficial de Holded `https://mcp.holded.com/mcp`, que publica registro dinámico de clientes OAuth (DCR) en `/.well-known/oauth-authorization-server`. Los toolkits privados por usuario requieren el plan Pro.
- **Hecho cuando**: test de que `proxy` rechaza rutas no permitidas y URLs absolutas.
- **Conector nativo**: solo con un ADR propio que justifique por qué no alcanza ninguna de las tres vías.
