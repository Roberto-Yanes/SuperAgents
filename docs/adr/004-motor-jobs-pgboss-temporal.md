# ADR 004 — Motor de jobs: pg-boss ahora, Temporal solo con criterios

Estado: aceptada (21/11/2026). Precisa el ADR-005 de `docs/spec-v3/90-decisiones.md`. Si discuten, manda este.

## Contexto

El motor ya corre sobre pg-boss 12, en el mismo Postgres del producto: colas, reintentos, `startAfter`, cron y un run a la vez por conversación. Alcanza para mensajes, aprobaciones, rutinas y secuencias.

Las tareas autónomas del ADR 003 pueden esperar una aprobación, una fecha o una tarea hija, y después seguir. Eso todavía se puede expresar con estado en Postgres más un job que despierta. No hace falta otro sistema para decirlo.

Temporal encaja cuando el hilo de una tarea larga deja de poder leerse en nuestras tablas, o cuando la cola le compite al OLTP. Hasta que eso se mida, sumar otro servicio es costo y otra superficie de residencia de datos.

## Decisión

Seguimos con pg-boss. El dominio y el runtime no hablan con pg-boss: hablan con un puerto de jobs y de esperas. El único adaptador de hoy es pg-boss.

Cuando migre, si migra, Temporal se hospeda en Hetzner, en la UE, al lado del Postgres. No uses Temporal Cloud fuera de la UE. El loop del agente es una activity. El workflow es el estado y los checkpoints. La fila de la Task en Postgres sigue siendo la fuente de los datos del cliente: el historial de Temporal no es la única copia.

## Puerto

El dominio pide esto. No pide nombres de cola.

```ts
interface JobPort {
  enqueue(name: string, payload: unknown, opts?: { runAt?: Date; group?: string }): Promise<void>;
  schedule(name: string, cron: string, payload?: unknown): Promise<void>;
}

interface WaitPort {
  wakeAt(taskId: string, at: Date): Promise<void>;
  wakeOnSignal(taskId: string, signal: string): Promise<void>;
}
```

Hoy `enqueue` es pg-boss (`startAfter`, grupo = conversación cuando el payload es de un hilo). `wakeOnSignal('approval')` es la transición que ya reencola `run.process` al resolver una decisión. Un test usa un adaptador en memoria. Ningún servicio de `domain/` importa `pg-boss`.

`run.execute` y `run.resume` siguen sin worker. No los revivas en el adaptador.

## Cuándo pasar a Temporal

Solo si se cumple al menos uno de estos criterios, medido, no supuesto. Anotá el número y la fecha en este ADR antes de escribir el adaptador.

1. **Tareas de días o semanas con esperas y reanudaciones**, y el estado en Postgres más el job no alcanza para reconstruir por qué la tarea está donde está. Señal objetiva: no podés responder, con las tablas de Task, RunStep y Approval, qué espera y qué ya hizo, sin leer logs.
2. **Reintentos que pierden estado o no se pueden seguir.** Señal objetiva: un efecto queda `UNKNOWN` o `FAILED` y no hay una sola historia (intento, entrada, resultado) para explicárselo al dueño. El outbox y el checkpoint actuales existen para que esto no pase. Si pasan igual, con casos concretos, recién ahí.
3. **Volumen que carga Postgres de más.** Señal objetiva: la cola, el poll de pg-boss o la tabla de jobs sostienen un atraso o un uso de CPU o de IO que no baja al separar `ROLE=worker` ni con índices. Medilo en el Postgres de producción, en la UE. Un pico de un deploy no cuenta.

Si ninguno se cumple, no migres. Una tarea que espera tres días con `WAITING_EXTERNAL` y un `wakeAt` no es el criterio 1: es el diseño de este ADR.

## Cómo sería la migración

No la hagas en este corte. Cuando los criterios estén anotados:

- El workflow guarda el estado durable de la tarea: plan, cupo, en qué espera está. Eso es el checkpoint, no el razonamiento.
- Cada tanda del loop es una activity con latido. Si se corta, Temporal reintenta la activity; el outbox y la huella de `RunStep` evitan un segundo efecto.
- Una aprobación es una señal (`wakeOnSignal`), no un hilo dormido en el proceso.
- Los datos del tenant (mensajes, contactos, secretos, el texto del objetivo) siguen en Postgres. El workflow referencia ids.
- El worker de Temporal corre en Hetzner EU. El historial del workflow también. No lo mandes a una región de fuera.
- pg-boss puede quedar para el cron fino y el outbox mientras el puerto tenga dos adaptadores. No dejes llamadas directas repartidas.

## Consecuencias

- El próximo cambio de código de la cola es el puerto y el adaptador pg-boss, no un servicio Temporal.
- El ADR-005 de la spec (pg-boss como única cola) queda vigente como implementación, no como acoplamiento.
- BullMQ y Redis siguen fuera. No sumes otro broker “mientras tanto”.
