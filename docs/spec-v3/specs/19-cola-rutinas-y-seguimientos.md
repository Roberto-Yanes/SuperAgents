# 19. Rutinas, seguimientos y email (F5)

### T19.1. Rutinas
- **Hacer**: CRUD `/v1/routines`; CRON con `boss.schedule` (`singletonKey = routineId:slot`); EVENT suscripto a tipos de `Event` (por ejemplo `lead.updated` con filtro); WEBHOOK por `/v1/hooks/routines/:token`; cada disparo crea `Task` y `Run ROUTINE`; `POST /v1/routines/:id/run`.
- **Modo port** (semántica): `../tropa-desktop/operations.mjs` (no superponer, condensar vencidas).
- **Hecho cuando**: tests de los tres disparadores y de no superposición.

### T19.2. Servicio de secuencias
- **Leer**: `docs/05-flujos.md` (Secuencia).
- **Hacer**: CRUD `/v1/sequences`; `enroll(contactId)`, `stop(reason)`; stop automático en respuesta del contacto (`stopOnReply`) y en opt-out.
- **Hecho cuando**: tests.

### T19.3. Worker de pasos
- **Hacer**: job `sequence.step` (clave `enrollmentId:step`): modo `TEMPLATE`, `FIXED` o `AI_DRAFT` (el agente redacta con contexto del contacto); aprobación opcional por paso; envío por outbox; agenda el siguiente paso con `startAfter`.
- **Hecho cuando**: test con reloj simulado de una secuencia de 3 pasos cortada por respuesta.

### T19.4. Email saliente
- **Hacer**: adaptador `SMTP` nativo (nodemailer, credencial en el vault) y adaptador `COMPOSIO_EMAIL` (envío con `GMAIL_SEND_EMAIL` u Outlook con `OUTLOOK_CREATE_DRAFT` + `OUTLOOK_SEND_DRAFT` (así se obtiene el ID del mensaje; `OUTLOOK_SEND_EMAIL` no lo devuelve), por la conexión del negocio); tool `email.send` (interna, `ASK_OWNER` por defecto) y uso en secuencias; `Message-ID` como `externalId`.
- **Hecho cuando**: tests con transporte fake y con fake de `AppGateway`.

### T19.4b. Email entrante por trigger (opcional en F5)
- **Hacer**: en un canal `COMPOSIO_EMAIL`, activar `GMAIL_NEW_GMAIL_MESSAGE` (en tiempo real con la auth administrada por Composio) con `target = CHANNEL:<id>`; el job `integration.event` normaliza el payload como mensaje entrante (`externalId` = ID del mensaje de Gmail) y sigue el flujo de WhatsApp (05-flujos, flujo 8).
- **Hecho cuando**: test con payload firmado; un email repetido no crea dos mensajes.

### T19.4c. Rutinas por trigger de Composio
- **Hacer**: `Routine.trigger = EVENT` con `eventType = composio:<TRIGGER_SLUG>` (p. ej. `composio:GOOGLECALENDAR_EVENT_CREATED`); el trigger se crea sobre la conexión elegida.
- **Hecho cuando**: test.

### T19.5. Tools internas de rutinas
- **Hacer**: `sequences.enroll`, `sequences.stop`, `routines.list`.
- **Hecho cuando**: test.
