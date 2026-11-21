# Revisión de código · everglow-agentes v2 · 21/11/2026

Esta es la segunda pasada sobre el zip v2. Copia revisada: `impl-review/src-v2/everglow-agentes/`. Tu código original no se tocó.

Sigue a `revision-codigo.md` (v1). Los IDs C1, H1…H6, M1…M12 y L1…L10 son los mismos de ese documento. Las rutas de archivo son relativas a `apps/server/src/` salvo que se diga otra cosa.

## Veredicto

**Salto grande respecto de v1.**
- El crash del WebSocket (C1) está resuelto y verificado en vivo.
- Ya no hay runs en paralelo por conversación.
- El bus reconecta solo.
- La alta pública está cerrada.
- El SSE tiene CORS y auth por ticket.
- Las aprobaciones pausan y reanudan el run, tanto en el chat como en WhatsApp Cloud.

Quedan tres cosas que conviene arreglar antes de un piloto con clientes reales:

1. **H1 sigue a medias.** Con dos mensajes seguidos, el segundo run vuelve a contestar. El contacto recibe una respuesta duplicada, aunque ahora sea en serie y no en paralelo.
2. **Contactos duplicados.** Si llegan dos mensajes a la vez de un número nuevo, se crean dos contactos.
3. **`handoff.request` no tiene salida.** Deja la conversación en HANDOFF y no hay ninguna ruta para devolvérsela al agente.

Los módulos nuevos de dominio (agenda, leads, rutinas y secuencias) están escritos como servicios, pero no están cableados: no tienen rutas, workers ni tests. En el mapa los marqué como parciales, no como hechos ni como inexistentes.

## 1. Checks automáticos (Postgres 17 + pgvector local, base `ega2`)

| Paso | Resultado |
|---|---|
| `pnpm install --frozen-lockfile` | OK |
| `prisma generate` / `prisma validate` | OK |
| `prisma migrate deploy` (5 migraciones nuevas) | OK |
| `typecheck`, `lint`, `lint:arch`, `format:check` | OK |
| `test` | **97 tests en verde en 13 archivos.** Tu PNG dice «46 tests en verde», pero ese número es anterior a los fixes. |
| `build` (server + sdk) | OK |
| Docker Compose, Caddy, CI | **No verificado**: en esta máquina no hay Docker. |

Log completo: `/tmp/checks2.log`.

## 2. Pruebas en vivo (servidor v2 con `NODE_ENV=production`, LLM simulado OpenAI-compatible)

| Prueba | v1 | v2 |
|---|---|---|
| **C1** · WS con subject `run:` + 36 guiones, subject en mayúsculas y JSON roto | El proceso se caía | Devuelve `bad_subject` y `bad_message`. El subject en mayúsculas se normaliza y suscribe. La conexión sigue abierta y `/health` responde 200. |
| **H1** · dos `POST /v1/chats/:id/messages` simultáneos | Dos runs en paralelo y dos respuestas | **Serializa**: el LLM recibe las llamadas una detrás de otra, sin solaparse. **Pero el 2.º run vuelve a contestar**: respondió «respuesta a: respuesta a: dos», o sea, le habló a su propia respuesta. Ver N1. |
| **CORS en SSE** con `Origin: http://localhost:5173` | Sin cabeceras CORS | Llegan `access-control-allow-origin` y `allow-credentials`. |
| **SSE con `?ticket=`** sin header | — | Funciona. Reusar el mismo ticket da 401 `invalid_ticket`. |
| **Alta pública** `POST /api/auth/sign-up/email` | Creaba el usuario | 400 `EMAIL_PASSWORD_SIGN_UP_DISABLED` |
| **H6** · `pg_terminate_backend` sobre el LISTEN | Los eventos dejaban de llegar | Reconecta en ~1 s («conexión LISTEN restablecida»). `/ready` muestra `bus:true`. Un SSE abierto mientras se cortaba el LISTEN recibió los 4 eventos del run. |
| Webhook con id inválido (L1) | 500 | 404 |
| `POST /v1/connections/:id/test` con body JSON vacío | 400 | OK |
| **Aprobación en chat**: tool `memory.save` con `ALWAYS` | — | El run queda en `WAITING_APPROVAL` con una aprobación PENDING. Al aprobarla se reanuda, ejecuta la tool, el LLM recibe el resultado y el run termina en `SUCCEEDED`. |
| **WhatsApp Cloud entrante (1→6)** con webhook firmado con HMAC | — | Firma mala: 401. El mismo `wamid` dos veces genera un solo run. El texto llega envuelto en `<mensaje_del_contacto>` (cara externa). Con `memory.save` en `ALWAYS`, el run pausa y se reanuda al aprobar. La respuesta sale por el outbox con `idempotencyKey = reply:<runId>` y queda **FAILED con el 401 de Meta** porque el token es falso. **El paso 6 real no está probado.** |
| Baileys | — | **No probado en vivo**, solo con los tests simulados del repo. |

Logs: `impl-review/srv2-live.log` y `impl-review/fakellm-v2.log`.

## 3. Estado de los hallazgos de v1

| ID | Estado | Evidencia |
|---|---|---|
| **C1** | ✅ Corregido (verificado en vivo) | `shared/validation.ts` (UUID_RE), `access/http/subjects.ts` (parseSubject, normaliza a minúsculas), `access/http/routes/ws.ts:60-110` (try/catch + `.catch`), `main.ts:17-19` (`unhandledRejection` se loguea; `uncaughtException` hace exit). |
| **H1** | ◐ Parcial | Serializa: `execution/workers/index.ts:22` (`run.process` con `groupConcurrency: 1`) y `orchestration/runtime/run-store.ts:38-58` (advisory lock por conversación + `RunBusyError`). Falta coalescer: `agent-runtime.ts:41-55` no comprueba si hay entrantes nuevos desde la última respuesta. Ver N1. |
| **H2** | ✅ Corregido | `integrations/tools/registry.ts:83-85` (cara externa: escritura con piso ASK_OWNER), `orchestration/runtime/prompt.ts:61-74` (envoltorio y saneo de la etiqueta). El envoltorio lo verifiqué en vivo con WhatsApp. |
| **H3** | ✅ Corregido (código y tests, sin prueba de caída real) | `orchestration/approvals/approval-gate.ts:143-149` (APPROVED→EXECUTING condicionado) y `:100-136` (EXECUTING huérfano → UNKNOWN). Para tools no aprobadas: `runtime/tool-binder.ts:58-70` (`dedupeKey`). Ojo: la `dedupeKey` incluye el índice de paso y los argumentos, así que si tras una caída el modelo regenera otros argumentos, la acción se repite. Es best-effort. |
| **H4** | ✅ Corregido | `execution/workers/message-outbound.ts:10-33` (QUEUED→SENDING con lease de 2 min → SENT/FAILED/UNKNOWN), `orchestration/runtime/reply-delivery.ts:17` (`reply:<runId>`) y el índice único `message_workspaceId_idempotencyKey_key`. FAILED verificado en vivo. |
| **H5** | ✅ Corregido | `integrations/composio/gateway.ts:76` (`composioUserId(workspaceId)`, armado en servidor) y `:106/137`. |
| **H6** | ✅ Corregido (verificado en vivo) | `execution/events/bus.ts:109` (`isHealthy`), `:158-197` (reconexión, replay por `lastSeq` y `maxSeqBefore`). `/ready` incluye bus y cola. `docker/Dockerfile:24` tiene HEALTHCHECK a `/ready`. |
| M1 | ✅ | `singletonKey` eliminado. |
| M2 | ✅ (solo código) | `integrations/channels/whatsapp-baileys.ts:50,84-118` (`safe()` y reintentos fuera de la sesión). No probado en vivo. |
| M3 | ✅ (verificado en vivo) | `access/auth/better-auth.ts:16` (`disableSignUp`, mínimo 12 caracteres). CLI `add-user`. |
| M4 | ✅ | `access/http/plugins/idempotency.ts:51-91` (`lockedUntil` y P2002 diferenciado). |
| M5 | ✅ | `access/auth/scopes.ts:30`: OPERATOR ya no tiene `approvals:write`. |
| M6 | ✅ (verificado en vivo) | `access/http/routes/runs.ts:84-151` (`?ticket=` en el preHandler, cabeceras copiadas antes de `hijack` en l.118). |
| M7 | ◐ Parcial | `data/tenant-guard.ts:62`. En `container.ts:142-153` lo usan conversaciones, agentes, runs y tools. `ConnectionService`, `ApiKeyService`, `ApprovalService`, `RunStore`, `RunControl` y `RunSweeper` siguen con el cliente sin guarda. Además, en producción la guarda solo hace `warn`. |
| M8 | ✅ | `gateway.ts:156-181`: DELETE/REMOVE siempre ALWAYS, `toolkitVersions` obligatorio en prod, try/catch por acción. |
| M9 | ✕ Pendiente | Lo declarás así en REVIEW-FIXES. |
| M10 | ✅ (solo código) | `integrations/channels/baileys-auth-state.ts:20-45` (AES-256-GCM con AAD `baileys:<conexión>:<fichero>`). |
| M11 | ✅ | `bus.ts:55-62` (`pg_advisory_xact_lock` por subject al publicar). |
| M12 | ✅ (código y tests) | `orchestration/runtime/run-sweeper.ts:16-40` (RUNNING sin latido, QUEUED perdido, WAITING_APPROVAL sin pendientes) y `workers/index.ts:29-33`. |
| L1…L10 | En general corregidos | Revisé L1 (404 en vivo), L5 (`LLM_BASEURL_ALLOWLIST`), L7 (`TRUST_PROXY`), L9 (LID ≠ teléfono en `contacts/service.ts:100-103`) y L10 (eslint 10.15). El resto no lo revisé uno por uno. |

## 4. Bugs nuevos o no detectados en v1

**N1 · Alto · Respuesta duplicada con mensajes seguidos (H1 residual)**
- **Qué pasa:** cada mensaje entrante crea su propio run. El run 1 ya ve los dos mensajes y los contesta. El run 2 arranca igual: su último mensaje es la respuesta del agente y vuelve a llamar al LLM.
- **Verificado en vivo:** `fakellm-v2.log` registra el 2.º START con `last='respuesta a: dos'`. En WhatsApp, que alguien mande «hola» y «quiero info» seguidos es lo normal.
- **Con Anthropic es peor:** un historial que termina en `assistant` se toma como *prefill*.
- **Arreglo:**
  - Al tomar el run en `execute` (después del `claim`), si no hay ningún INBOUND posterior al último OUTBOUND del agente, cerrarlo como `CANCELLED` con `reason: "sin mensajes nuevos"` y sin llamar al LLM.
  - Alternativa: al encolar, si ya hay un run QUEUED para esa conversación, no crear otro (coalescer).

**N2 · Medio · Contactos duplicados en carrera**
- **Dónde:** `domain/contacts/service.ts:104-123` hace `findFirst` y después `create`, sin índice único sobre `externalIds`.
- **Verificado en vivo:** dos webhooks simultáneos de un número nuevo crearon dos filas «Ana» con el mismo `externalIds.whatsapp`. El `conversation.upsert` (`execution/workers/channel-inbound.ts:30`) también chocó con P2002. Ese error se reintenta y no se pierde, pero ensucia los logs.
- **Por qué importa:** leads, memoria y agenda cuelgan del contacto.
- **Arreglo:**
  - Tabla `ContactIdentity(workspaceId, channel, externalId)` con `@@unique`, o `pg_advisory_xact_lock` por esa terna dentro de una transacción.
  - Capturar P2002 en el upsert de conversación y releer.

**N3 · Medio · `handoff.request` deja la conversación muda para siempre**
- **Dónde:**
  - `integrations/tools/builtin/index.ts:61-72` pone `status: "HANDOFF"`.
  - `orchestration/runtime/agent-runtime.ts:47` cancela todo run posterior.
  - `ConversationService.release` existe (`domain/conversations/service.ts:139`), pero ninguna ruta lo llama.
- **Consecuencia:** los mensajes del contacto se guardan pero nadie los ve, porque no hay inbox por API, y el agente no vuelve a responder salvo que se edite la base a mano.
- Lo verifiqué en el código, no en vivo.
- **Arreglo mínimo:** `GET /v1/conversations?status=HANDOFF`, `POST /v1/conversations/:id/release` y `POST /v1/conversations/:id/reply`. El motor ya existe.

**N4 · Bajo · Dos números de WhatsApp en el mismo workspace comparten conversación**
- **Dónde:** la clave única es `(workspaceId, channel, externalThreadId)` y no incluye `connectionId`.
- **Consecuencia:** el mismo cliente escribiendo a dos números cae en la conversación del primero, con su agente.
- Ya estaba en v1, pero no lo había señalado.

**N5 · Bajo · HEALTHCHECK con puerto fijo**
- **Dónde:** `docker/Dockerfile:24` apunta a `127.0.0.1:3000` e ignora `PORT`.
- **Detalle:** con Compose solo, un contenedor `unhealthy` no se reinicia (haría falta autoheal o el orquestador).

**N6 · Bajo · Observabilidad declarada pero sin implementar**
- `prom-client` está en `package.json` pero no se usa: no hay `/metrics`.
- `Run.costUsd` existe en el esquema pero nada lo escribe. Los tokens sí se guardan en `usage`.

**N7 · Bajo · El ticket viaja en la URL del SSE**
- Puede terminar en los logs de acceso de Caddy o del proxy.
- Es de un solo uso y de vida corta, así que el riesgo es bajo. Conviene no loguear la query de esa ruta.

**Nota (no es bug).** Las colas viejas `run.execute` y `run.resume` siguen drenando sin grupo (`workers/index.ts:27-28`). Nada encola en ellas y el `claim` con lock las protege, así que se pueden quitar en la próxima versión.

## 5. Marcas de tu PNG (`docs/annotate-estado.py`) que no coinciden con el código

No pude abrir el PNG que adjuntaste en el chat porque es un archivo privado. Usé `docs/arquitectura-v3-estado.png` y `docs/annotate-estado.py` del zip. Ese PNG y ese script son de las 19:06, anteriores a los módulos de dominio (19:12-19:14) y a los fixes (19:57-20:03). Por eso varias marcas quedaron viejas.

| Bloque | Tu marca | Lo verificado | Nueva marca |
|---|---|---|---|
| Panel: «46 tests en verde» | — | 97 tests en 13 archivos | corregido |
| Panel: «chat desde la UI (A→E) y WhatsApp (1→6) con aprobaciones que pausan y reanudan» | — | **A→E funciona por API**; la UI no existe (vos mismo la marcás ✕). **1→5 funciona con Cloud API**, con firma, dedupe, cara externa, aprobación y outbox. **El paso 6 nunca se probó real**: con token falso queda FAILED. Baileys, solo simulado. Las aprobaciones pausan y reanudan **en ambos flujos (verificado)**. | matizado en el panel |
| Agent runtime | ✓ | Serializa, pero responde dos veces (N1) | ◐ «serializa · 2.º run sobra» |
| Contactos | ◐ «Por canal · sin API» | Correcto. Además, `ContactService` tiene un CRUD escrito sin cablear y está el bug N2. | ◐ «sin API · duplica» |
| Inbox y takeover | ◐ «Motor sí · sin API» | Correcto. Falta decir que el handoff no tiene salida (N3). | ◐ |
| Leads y embudo | ✕ | `domain/leads/service.ts` (152 líneas) + modelos `Lead` y `PipelineStage` + migración. Nadie lo importa. | ◐ «servicio sin cablear» |
| Agenda y turnos | ✕ | `domain/agenda/*` (370 líneas: disponibilidad, reservas, cancelación) + modelos `Calendar` y `Appointment`. Sin cablear. | ◐ «servicio sin cablear» |
| Rutinas | ◐ «Modelo · sin worker» | Hay más que el modelo: `RoutineService` con `fire()` y `scheduleAll()`. Sin worker ni API. | ◐ «sin worker ni API» |
| Secuencias | ✕ | `SequenceService` con `enroll`, `stop`, `runStep` y `renderTemplate`. Sin worker ni API. | ◐ «sin worker ni API» |
| Base de conocimiento | ✕ | Sigue ✕, pero ya existen las tablas `knowledge_document` y `knowledge_chunk` (con `embedding vector`). | ✕ «solo tablas» |
| PostgreSQL | ✓ «sin tablas RAG» | Las tablas RAG **sí existen** (`prisma/schema.prisma:730-772`); lo que falta es usarlas. | ✓ «tablas RAG sin uso» |
| Archivos | ◐ «Disco · sin S3 ni cifrado» | «Sin cifrado» es incorrecto: la sesión Baileys va cifrada (M10). Tampoco hay módulo de archivos en disco: `StoredFile` es solo el modelo. | ◐ «solo sesión Baileys cifrada» |
| Cola: chips `run.execute` y `run.resume` | ✓ | Ahora es `run.process` (execute y resume en un solo grupo), más `message.outbound` y `run.sweep` | chips actualizados |
| Composio Gateway | ✓ «sin triggers» | Los triggers son parte del bloque; M9 sigue pendiente | ◐ «sin triggers» |
| Meta | ✓ «sin probar real» | Cloud verificado hasta el 401 de Meta; Baileys solo simulado | ◐ |
| Docker Compose | ✓ | Los archivos existen; no lo pude levantar (no hay Docker aquí) | ✓ «no probado aquí» |

Marcas que coinciden: UI ✕, Integraciones ✓, Equipo ◐, Gateway, Auth y OpenAPI ✓, Orquestador ✕, Aprobaciones ✓, Memoria ◐, Capa LLM ✓ (sin probar real), Conversaciones ✓, Tareas y runs ✓, Plantillas ✕, Registro de tools ✓, Ejecutores ✕, Adaptadores ◐ (Email e Instagram ✕), Bus ✓, Backups ✕, Logs/Auditoría/Health/Tokens ✓, Métricas ✕, Costos ◐, Vault ◐, Firmas ◐, Claves/Caras/TLS/Rate limit ✓.

## 6. Mapa actualizado

Archivos:
- `docs-v3/diagramas/gen.py` (v1.2): agrega etiquetas de estado por bloque, puntos de estado en chips, colas y bandas, y el panel inferior «Estado de implementación».
- `docs-v3/diagramas/arquitectura.{png,svg,pdf}`.
- `docs-v3.zip`, regenerado.

El diseño original no cambió. Solo se actualizaron los chips de cola y el paso B de la leyenda (`run.process`) para reflejar lo construido.

## 7. Próximos pasos sugeridos (en orden)

1. **N1:** coalescer o cancelar los runs sin entrantes nuevos. Test: dos mensajes seguidos deben producir una sola llamada al LLM.
2. **N3 + inbox:** rutas de inbox, takeover, release y reply sobre `ConversationService`, más rutas de contactos (`ContactService` ya existe).
3. **N2:** identidad única de contacto por canal.
4. Cablear agenda y leads (rutas + tools para el agente + tests). Después, rutinas y secuencias con sus workers (`routine.cron`, `sequence.step`).
5. Probar con cuentas reales: un número de prueba de Cloud API, Composio con un toolkit y un proveedor de LLM real.
6. Métricas (`/metrics` con prom-client), `costUsd` por run y M9.

## 8. Lo que no verifiqué

- Docker Compose, Caddy y TLS, y el HEALTHCHECK en un contenedor real.
- El envío real a Meta (paso 6), Baileys en vivo, Composio real y proveedores de LLM reales: todo eso se probó solo con dobles o con credenciales falsas.
- Caídas reales del worker a mitad de una tool (H3 y M12): solo los tests del repo.
- L2, L3, L4, L6 y L8, uno por uno.
