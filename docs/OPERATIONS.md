# Operación

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

Modelos locales (opcional): `docker compose -f docker/compose.yaml --profile local-llm up -d` y crear una conexión `llm.openai_compatible` con `baseURL` `http://ollama:11434/v1`.

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
