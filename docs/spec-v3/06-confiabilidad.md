# 06. Confiabilidad

## Idempotencia

| Dónde | Clave | Mecanismo |
|---|---|---|
| Mensajes entrantes | `externalId` del proveedor (wamid, ID de Baileys, Message-ID) | `Message @@unique([workspaceId, externalId])` + `singletonKey` del job |
| Envíos salientes | `runId:stepIndex`, `enrollmentId:step`, `humanMsg:<uuid>` | `OutboundSend` se inserta **antes** de llamar al proveedor; si ya existe `SENT`, no se reenvía |
| Turnos de agenda (vía Composio) | `Appointment.idempotencyKey` | La acción `GOOGLECALENDAR_CREATE_EVENT` de Composio no acepta un `id` propio. La clave va en `extended_properties.private.idem`; antes de reintentar se busca el evento con `GOOGLECALENDAR_EVENTS_LIST` y `privateExtendedProperty=idem=<clave>`. `create_meeting_room=false` siempre |
| Espejo en CRM (Holded u otro, vía Composio) | `ExternalLink` (`connectionId`, `entityType`, `entityId`) | Upsert: si existe el vínculo se actualiza; si no, se busca por email o teléfono (`HOLDED_FIND_CONTACTS`) antes de crear |
| Acciones de apps (`app.*`) | `runId:stepIndex` en `OutboundSend kind=app` | Si quedó `SENT` no se repite; un timeout queda `UNKNOWN` y se informa al LLM en vez de reintentar a ciegas |
| Triggers de Composio | ID del evento | `singletonKey` del job `integration.event` |
| API pública | `Idempotency-Key` | `IdempotencyRecord` 24 h, compara hash del body (409 si difiere) |
| Jobs | `singletonKey` de pg-boss | Un solo job vivo por clave |

**Estado `UNKNOWN`**: si el proveedor no respondió (timeout) no se reintenta a ciegas. Para WhatsApp se marca `UNKNOWN` y, si llega el estado del mensaje por webhook o socket, se reconcilia; si no, el run sigue y se avisa en el inbox. Mejor un mensaje perdido visible que uno duplicado al cliente.

## Reintentos

- pg-boss con `retryLimit` y `retryBackoff` por cola; `deadLetter` a una cola `*.dead` visible en `/runs?status=FAILED` y auditoría.
- Errores clasificados: `retryable` (5xx, 429 con `Retry-After`, red) y `fatal` (4xx de validación, auth). Errores de Composio: 429 (límite por minuto del plan, header `Retry-After`) y 5xx son `retryable`. Un connected account `EXPIRED` o un 401 de la app marcan la `Connection` como `NEEDS_REAUTH` y emiten `connection.status`; Composio también avisa por el webhook de ciclo de vida. Si Composio no responde, las tools `app.*` fallan con `retryable` y el agente sigue con lo demás: la conversación por WhatsApp no depende de Composio.
- Llamadas LLM: 3 reintentos con backoff; fallback opcional a otro modelo configurado en el agente.

## Checkpoints y reanudación

- Cada paso del loop se persiste en `RunStep` (entrada, salida, estado) **antes** de pasar al siguiente.
- Al reanudar (`run.resume` tras aprobación, subtarea o caída del proceso) el runtime reconstruye los mensajes desde `RunStep` y continúa desde el último paso `DONE`. Un paso `PENDING` con tool `idempotent: true` se reintenta con la misma clave; uno no idempotente se marca `FAILED` y se informa al LLM.
- Al arrancar, un barrido marca como `QUEUED` los runs `RUNNING` sin heartbeat (más de 2 min) y los reencola.
- Límite de pasos por run (`limits.maxStepsPerRun`) y de profundidad de delegación (3).

## Concurrencia

| Regla | Implementación |
|---|---|
| **Una conversación, un run a la vez** | Job `run.execute` con `group: { id: conversationId }` y `groupConcurrency: 1` (pg-boss 12) |
| Mensajes que llegan mientras el agente piensa | Se agregan al contexto del run siguiente (debounce de 2 s antes de encolar) |
| Runs simultáneos por agente | `limits.maxConcurrentRuns` con `group: { id: agentId }` en una cola aparte, o semáforo en DB ⚠ VERIFICAR combinación de grupos en pg-boss |
| Socket de Baileys | Un solo proceso por canal: `pg_try_advisory_lock(hash(channelId))` |
| Envíos por canal | Rate limit por canal (Baileys: 1 msg/s y 20/min, como Tropa `channels/whatsapp.mjs`; Cloud API: según tier ⚠ VERIFICAR) |
| Rutinas | Cron de pg-boss (`schedule`); `singletonKey = routineId:slot` evita duplicados |

## Disponibilidad

- El proceso corre bajo Docker con `restart: unless-stopped` y healthcheck en `/ready` (DB y cola OK).
- Baileys reconecta con backoff y emite `channel.status`; si la sesión se cierra (logout), pasa a `DISCONNECTED` y avisa al dueño.
- Cloud API: Meta reintenta webhooks fallidos hasta 7 días ([Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint)); el handler responde 200 apenas persiste el payload crudo.
