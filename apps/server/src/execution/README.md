# execution/ — Capa 06 · Ejecución asíncrona

```
execution/
  queue/
    jobs.ts     Nombres de cola del diagrama y esquema zod de cada payload; interfaz JobQueue
    boss.ts     pg-boss 12: arranque, colas con reintentos y backoff, envío validado, workers
  workers/
    index.ts             Registro de workers por cola
    channel-inbound.ts   Entrante de canal → contacto, conversación, dedupe, run
    message-outbound.ts  Outbox → adaptador de la conexión de la conversación → envío (idempotente por estado; reintenta errores temporales)
    channel-session.ts   Arranque, parada y desvinculación de sesiones de Baileys
    appointment-reminder.ts  Recordatorio de una cita reservada, por el outbox si hay conversación
  events/
    bus.ts      Bus de eventos: tabla Event (seq global) + trigger NOTIFY; backlog y suscripción para SSE/WS.
                Las notificaciones se procesan en orden para no entregar eventos desordenados.
```

Colas con worker: `channel.inbound`, `run.process` (un run a la vez por conversación), `run.sweep` (cada minuto), `message.outbound`, `sequence.step`, `routine.cron` (cada minuto, pase de las rutinas vencidas), `appointment.reminder`, `approvals.expire` (cada 5 min), `channel.session`. Sin worker todavía: `crm.sync` e `integration.event`. `run.execute` y `run.resume` ya no se registran.

Garantías: cada handler es idempotente. El estado en base de datos manda: un run solo se toma si pasa de `QUEUED` a `RUNNING` (o de `WAITING_APPROVAL` a `RUNNING`) en un UPDATE condicionado.
