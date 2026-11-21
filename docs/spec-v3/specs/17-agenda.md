# 17. Agenda sobre Composio (F3)

Base: spec 13 de docs-v2 (cálculo de slots). El acceso a Google Calendar va por Composio (ADR-014, toolkit `GOOGLECALENDAR`: 50 acciones, 6 triggers, auth OAuth administrada por Composio). Cualquier otra agenda con toolkit en Composio entra igual: solo cambia el mapeo.

### T17.1. Slots (puro)
- **Hacer**: `computeSlots({ busy, businessHours, durationMin, bufferMin, from, to, timezone, minNoticeMin })` sin I/O.
- **Hecho cuando**: tests con husos, feriados configurados y bordes de día.

### T17.2. Mapeo de agenda (`CalendarPort`)
- **Hacer**: `CalendarPort` con `busy(from, to)`, `create(event, idemKey)`, `patch`, `cancel`, `findByIdem(idemKey)`. La implementación `googlecalendar` usa el gateway:
  - `GOOGLECALENDAR_FIND_FREE_SLOTS` (consulta freeBusy) para ocupado y libre.
  - `GOOGLECALENDAR_CREATE_EVENT` con `extended_properties.private.idem = <clave>`, `create_meeting_room=false` (por defecto crea un Meet) y `timezone` del workspace.
  - `GOOGLECALENDAR_EVENTS_LIST` con `privateExtendedProperty=idem=<clave>` para buscar antes de reintentar (la acción de crear no acepta `id` propio).
  - `GOOGLECALENDAR_PATCH_EVENT` y `GOOGLECALENDAR_DELETE_EVENT` (slugs verificados en el catálogo el 21/11/2026).
- **Hecho cuando**: tests con fake de `AppGateway`; un reintento tras timeout encuentra el evento y no duplica.

### T17.3. Tools
- **Hacer**: `calendar.check_availability`, `calendar.book` (vía outbox, crea `Appointment` con `idempotencyKey` y `externalEventId`), `calendar.reschedule`, `calendar.cancel`. Son tools nativas (cara externa, reglas en código); por dentro llaman al `CalendarPort`. Las acciones crudas de Google Calendar no se exponen al agente externo.
- **Hecho cuando**: test de extremo a extremo con fakes: el agente consulta, reserva, y un reintento no duplica.

### T17.4. Configuración y recordatorios
- **Hacer**: `Agent.schedule` y config de agenda (conexión, calendario, duración, buffers) por API; job `appointment.reminder` con `startAfter` 24 h y 2 h antes, por el canal del contacto (plantilla si Cloud API). Opcional: trigger `GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER` para marcar `Appointment` cancelado si el dueño lo borra a mano.
- **Hecho cuando**: tests del job y del trigger.
