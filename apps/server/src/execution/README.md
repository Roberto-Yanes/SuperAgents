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
  events/
    bus.ts      Bus de eventos: tabla Event (seq global) + trigger NOTIFY; backlog y suscripción para SSE/WS.
                Las notificaciones se procesan en orden para no entregar eventos desordenados.
```

Colas: `channel.inbound`, `run.process` (ejecución y reanudación, un run a la vez por conversación con grupos de pg-boss), `run.sweep` (barrido de huérfanos, cada minuto), `message.outbound` (QUEUED→SENDING→SENT/UNKNOWN), `sequence.step`, `routine.cron`, `crm.sync`, `integration.event`, `appointment.reminder`, `approvals.expire` (programada cada 5 min), `channel.session`. Las que todavía no tienen worker se activan con su módulo de dominio.

Garantías: cada handler es idempotente. El estado en base de datos manda: un run solo se toma si pasa de `QUEUED` a `RUNNING` (o de `WAITING_APPROVAL` a `RUNNING`) en un UPDATE condicionado.
