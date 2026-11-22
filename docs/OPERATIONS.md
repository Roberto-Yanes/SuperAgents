# Operación

## Residencia

Los clientes son europeos. El Postgres, los backups y el proceso van en un proveedor de la UE. La referencia es Hetzner. No subas un volumen con mensajes de clientes a una región de afuera.

Los modelos son BYOK y tienen que declarar región UE ([ADR 005](adr/005-llm-residencia-ue.md)). El producto ya lo exige: guardar una conexión LLM pide proveedor, región y host, y rechaza xAI, `api.openai.com`, las APIs públicas de Anthropic y Google y cualquier host sin región demostrable. La misma comprobación corre al usar la conexión: si dejó de cumplir, la tarea queda `BLOCKED` con motivo `model_region` sin llamar al modelo. `LLM_BASEURL_ALLOWLIST` limita hosts además de esa regla.

| Proveedor                   | Tipo de conexión        | Config                                                                                                                                                                                                |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure OpenAI                | `llm.azure_openai`      | `region` (p. ej. `swedencentral`) y `endpoint` regional (`https://swedencentral.api.cognitive.microsoft.com`) o un recurso con la región en el nombre (`https://acme-swedencentral.openai.azure.com`) |
| Mistral                     | `llm.mistral`           | nada (región `eu`, host `api.mistral.ai`)                                                                                                                                                             |
| Modelo en el mismo servidor | `llm.openai_compatible` | `provider: "self_hosted"`, `region` del servidor (`fsn1`, `es`…), `baseURL` interno (`http://ollama:11434/v1`)                                                                                        |
| Modelo hospedado en la UE   | `llm.openai_compatible` | `provider: "eu_hosted"`, `region`, `baseURL` cuyo host esté en `llmPolicy.hosts` (`PUT /v1/workspace/llm-policy`)                                                                                     |

Composio Cloud procesa en Estados Unidos. Si el cliente exige residencia UE para esas acciones, no uses esa app o usá Composio self-hosted. Temporal, si algún día aplica, también va en Hetzner EU ([ADR 004](adr/004-motor-jobs-pgboss-temporal.md)).

## Despliegue (VPS, PC o mini PC)

1. Docker y Docker Compose instalados; dominio apuntando al servidor (puertos 80 y 443 abiertos).
2. `cp .env.example .env` y rellenar: `POSTGRES_PASSWORD`, `DATABASE_URL` (con esa contraseña), `SECRET_KEY` (`openssl rand -base64 32`), `BETTER_AUTH_SECRET` (`openssl rand -base64 48`), `PUBLIC_URL`, `DOMAIN`, `CORS_ORIGINS`.
3. `docker compose -f docker/compose.yaml up -d --build`. El contenedor aplica las migraciones al arrancar.
4. Alta inicial: `docker compose -f docker/compose.yaml exec server node dist/cli.js bootstrap --name "Mi negocio" --slug mi-negocio`. Guardar la API key: no se vuelve a mostrar.
5. Usuarios de la UI (el alta pública está cerrada, `AUTH_SIGNUP=disabled`):
   `docker compose -f docker/compose.yaml exec server node dist/cli.js add-user --workspace mi-negocio --email ana@x.com --name "Ana" --role OWNER`.
   Sin `--password` genera una y la muestra una vez. Roles: OWNER/ADMIN aprueban acciones; OPERATOR atiende chats pero no aprueba.
6. Comprobar: `https://<dominio>/health` (el proceso vive) y `/ready` (base de datos, bus de eventos y cola). El healthcheck de Docker usa `/ready`.

### Variables de seguridad

| Variable                | Por defecto                   | Para qué                                                                                                                                          |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY`           | 1                             | Saltos de proxy de confianza (Caddy = 1). Pon 0 si expones el puerto 3000 directamente: si no, `X-Forwarded-For` falsearía la IP del rate limit.  |
| `AUTH_SIGNUP`           | disabled                      | Alta pública en `/api/auth/sign-up`. Déjalo cerrado y crea usuarios con `add-user`.                                                               |
| `LLM_BASEURL_ALLOWLIST` | (vacío)                       | Hosts permitidos como `baseURL` de conexiones LLM, p. ej. `ollama,api.mistral.ai`. Siempre se bloquean metadatos de nube y link-local.            |
| `TENANT_GUARD`          | error (dev/test), warn (prod) | Guarda que detecta consultas masivas sin `workspaceId` en los servicios por workspace.                                                            |
| `COMPOSIO_API_KEY`      | (vacío = deshabilitado)       | Una sola key de proyecto de Composio por servidor. No va en la conexión ni en la UI. Si falta, `/ready` dice `composio: disabled` y no hay tools. |

Modelos locales (opcional): `docker compose -f docker/compose.yaml --profile local-llm up -d` y crear una conexión `llm.openai_compatible` con `{"provider":"self_hosted","region":"fsn1","baseURL":"http://ollama:11434/v1"}`.

### Políticas del workspace (OWNER/ADMIN, scope `workspace:admin`)

- `PUT /v1/workspace/risk-policy`: riesgo de la tool → `direct` o `approval`. Defaults: `read` directo, `write` directo en cara interna, `send` y `money` con aprobación, `delete` siempre con aprobación. Bajar `send` o `money` a directo exige un usuario OWNER y queda auditado.
- `PUT /v1/workspace/llm-policy`: `allowed` (subconjunto de `azure_openai`, `mistral`, `eu_hosted`, `self_hosted`) y `hosts` UE propios.
- `PUT /v1/workspace/task-limits`: cupo por defecto de las tareas (pasos, costo de referencia, tiempo). Nunca supera el techo de la plataforma (200 pasos, 25 USD, 7 días).

## Copias de seguridad

- `pg_dump` diario cifrado fuera del servidor y copia del volumen `files` (archivos y sesión de Baileys, que se guarda cifrada con `SECRET_KEY`).
- Guardar `SECRET_KEY` aparte de las copias: sin ella no se pueden descifrar las credenciales de las conexiones.
- Probar una restauración al mes.

## Rotación de `SECRET_KEY`

1. Mover la clave actual a `SECRET_KEY_OLD` y poner una nueva en `SECRET_KEY`.
2. Reiniciar: se descifra con cualquiera de las dos y se cifra con la nueva.
3. Recifrar todas las conexiones: `node dist/cli.js rotate-secrets` (también migra los secretos antiguos sin AAD).
4. Quitar `SECRET_KEY_OLD` y reiniciar. Las sesiones de Baileys se recifran solas la próxima vez que se guardan; para forzarlo, desvincular y volver a vincular.

## Estados que necesitan una persona

- **Tarea `BLOCKED`** (evento `task.blocked`): se acabó el cupo (`steps`, `cost`, `time`) o la conexión del modelo ya no cumple la política UE (`model_region`). Para cupo: `POST /v1/tasks/<id>/limits`; la tarea sigue desde su checkpoint. Para `model_region`: arreglar la conexión o la política.
- **Tarea `WAITING_EXTERNAL`** sin fecha: espera un dato del dueño (`waiting.reason`). Se responde con `POST /v1/tasks/<id>/signal`.

- **Mensaje `UNKNOWN`** (evento `message.unknown`): el envío se cortó a mitad (timeout o caída) y pudo llegar o no. No se reenvía solo: revisar en el canal y reenviar a mano si hace falta.
- **Aprobación `UNKNOWN`** (evento `approval.unknown`): el proceso cayó mientras ejecutaba una acción aprobada. Comprobar en la app de destino si se hizo.
- **Run `FAILED` con "Run abandonado"**: el barrido de huérfanos lo reencoló 3 veces sin progreso.

## Migraciones en desarrollo

`prisma migrate dev` es interactivo y falla en entornos sin TTY (agentes de IA, CI). Alternativa equivalente:

```bash
d=prisma/migrations/$(date +%Y%m%d%H%M%S)_nombre && mkdir -p $d
pnpm prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script > $d/migration.sql
pnpm prisma migrate deploy && pnpm prisma generate
```

## Observabilidad

- Logs JSON por stdout (pino) con `component`, `runId` y `jobId`; credenciales redactadas.
- `AuditLog`: altas y cambios de agentes, API keys y decisiones de aprobación.
- Uso de tokens acumulado en `Run.usage`.
