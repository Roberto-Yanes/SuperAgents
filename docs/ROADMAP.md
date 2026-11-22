# Backlog: del motor actual al runtime autónomo

Dirección: [ADR 003](adr/003-runtime-agentes-autonomos.md), [ADR 004](adr/004-motor-jobs-pgboss-temporal.md), [ADR 005](adr/005-llm-residencia-ue.md). El calendario por semanas de `spec-v3/09-roadmap.md` era el camino a la paridad de capacidades. Esta lista lo reemplaza como orden de trabajo.

No hay fechas. El orden es de dependencia. E7 es un candado: no proceses datos reales de un cliente español antes.

## Ya está

No lo reabras salvo que un criterio de aceptación de abajo lo pida.

- **Runtime autónomo (22/11/2026):** E1, E2, E3, E4, E5, E7 y E10 cumplen sus criterios, con tests en `test/tasks.test.ts` y `test/runtime-policies.test.ts`. De E8 está la auditoría por tramo y los logs sin ticket; falta exportar y borrar un contacto con sus tareas. Decisiones en DECISIONS D-024.

- Canal WhatsApp (Baileys y Cloud API), inbox, takeover, respuesta humana.
- Cola D1: mensajes durante `WAITING_APPROVAL` y un solo run al resolver. N1 evita el doble reply.
- Composio con una sola key de servidor. Acciones de la lista blanca. Sin triggers (E9).
- Agenda (sin Google Calendar conectado), leads (sin adaptador `crm.sync`), rutinas y secuencias con worker.
- Outbox, guarda de tenant, conversación por conexión, identidad de contacto, `/metrics`, costo de referencia por run.
- Aprobaciones que pausan y reanudan.

## Orden

| #   | Épica                  | Para qué                                      | Depende de |
| --- | ---------------------- | --------------------------------------------- | ---------- |
| E1  | Puerto de jobs         | Poder esperar y despertar sin nombrar pg-boss | —          |
| E2  | Task                   | Objetivo, plan, estados, checkpoint           | E1         |
| E3  | Cupos                  | Pasos, costo, tiempo                          | E2         |
| E4  | Riesgo del tenant      | Directo o aprobación, reusando la cola D1     | E2         |
| E5  | Tareas desde la app    | El producto más allá de WhatsApp              | E2, E3, E4 |
| E6  | Memoria                | Investigar antes de actuar                    | E2         |
| E7  | LLM en la UE           | Candado para datos reales                     | —          |
| E8  | Auditoría              | Decisión, dato, tool, modelo, región          | E2, E7     |
| E9  | Canal y CRM que faltan | Producción de WhatsApp y espejo de leads      | —          |
| E10 | Delegación             | Recién cuando una tarea no cierra sola        | E2, E4     |
| E11 | Temporal               | Solo con un criterio del ADR 004 medido       | E1, E2     |

E7 y E9 se pueden construir en paralelo con E1–E4. No las dejes para el final si hay un piloto.

## E1. Puerto de jobs — hecho

pg-boss sigue siendo el adaptador. El dominio deja de importarlo.

Está hecho cuando:

- existe el puerto del ADR 004 (`enqueue`, `schedule`, `wakeAt`, `wakeOnSignal`) y el adaptador pg-boss es el único de producción;
- un test usa un adaptador falso y no levanta Postgres para afirmar que el dominio encoló;
- `domain/` no importa `pg-boss`;
- el comportamiento actual de `run.process`, rutinas, secuencias y recordatorios no cambia.

## E2. Task — hecho

Una Task es el objetivo. Un Run es un tramo. WhatsApp sigue entrando por `receive`.

Está hecho cuando:

- `POST /v1/tasks` con un objetivo crea una Task `PLANNING` y un tramo; el workspace sale del principal, no del body;
- los estados del ADR 003 se persisten, y un worker que muere a mitad retoma desde el último checkpoint sin repetir un efecto ya tomado por el outbox;
- un mensaje de WhatsApp durante `WAITING_APPROVAL` no llama al modelo, y al resolver sale un solo tramo para lo encolado (siguen verdes los tests D1);
- dos mensajes seguidos sin aprobación producen una sola llamada al modelo;
- una Task de la app sin conversación no abre un hilo de WhatsApp por el solo hecho de existir.

## E3. Cupos — hecho

Está hecho cuando:

- al llegar a pasos, costo o tiempo la Task queda `BLOCKED` con el motivo, y no hay otra llamada al modelo;
- una espera de aprobación no consume el cupo de pasos y, con la política por defecto, pausa el reloj de tiempo;
- el dueño puede ampliar el cupo y la tarea sigue desde el checkpoint;
- el costo del tramo sigue anotándose en `Run.costUsd`.

## E4. Riesgo por tenant — hecho

Está hecho cuando:

- el workspace tiene una política riesgo → directo o aprobación, y solo puede endurecer el piso de la tool y de la cara externa;
- una tool `read` de cara interna corre sola, y una `send` queda en `WAITING_APPROVAL` hasta que alguien con `approvals:write` decide;
- en una conversación, esa espera sigue pasando por la cola D1;
- `delete` no se puede pasar a directo;
- el rechazo y la caducidad reanudan el tramo e informan al modelo, sin ejecutar el efecto.

## E5. Tareas desde la app — hecho

Tres usos, la misma Task. WhatsApp no es requisito.

Está hecho cuando:

- el dueño lanza un objetivo desde la API y sigue el plan por el bus de eventos (pasos, tools, cierre);
- **seguimiento de un lead:** una Task con el id del lead puede anotar, mover etapa o inscribir una secuencia; enviar un mensaje es `send` y pide aprobación; no existe un guion fijo de “paso 1, paso 2”;
- **contenido:** una Task produce un borrador y no lo publica sola si publicar es `send`;
- cancelar la Task deja de gastar cupo y no manda lo que estaba en espera.

## E6. Memoria

Está hecho cuando:

- hay RAG del negocio en pgvector, aislado por workspace, y `kb.search` solo ve ese workspace;
- el modelo de embeddings cumple el ADR 005 (región UE o self-hosted en la UE);
- la memoria del contacto solo aparece en la cara externa de ese `contactId`;
- las notas del agente no se inyectan en la cara externa;
- borrar el contacto borra su memoria;
- una Task corre igual si las tres capas están vacías.

## E7. LLM en la UE — hecho

Candado de piloto. Se puede construir antes que E2.

Está hecho cuando:

- guardar una conexión LLM exige proveedor, región y host;
- se rechazan xAI/Grok, `api.openai.com` y cualquier host que no esté en la lista UE del ADR 005, sin loguear la clave;
- el tenant no puede agregar un proveedor de afuera;
- al ejecutar, una conexión que ya no cumple la política deja la Task en `BLOCKED` con motivo `model_region` y cero llamadas;
- un Azure OpenAI en región UE y un Mistral EU de prueba (host permitido, clave ficticia en el test) sí se guardan.

## E8. Auditoría — parcial (falta exportar y borrar un contacto; retención configurable)

Está hecho cuando:

- cada cierre, bloqueo o cancelación escribe decisión, categorías de datos, tools (nombre, riesgo, aprobación), modelo, proveedor, región y resultado;
- ese registro no contiene la clave ni el cuerpo de un secreto;
- los logs de aplicación no contienen el prompt ni `req.query.ticket`;
- exportar y borrar un contacto incluye mensajes, memoria y tareas de canal de ese contacto;
- la retención default es la del ADR 005 y el tenant puede bajarla.

## E9. Lo que ya estaba pendiente

No son el runtime, pero el canal de producción y el espejo de leads no cierran sin esto.

### Triggers de Composio (M9, `integration.event`)

Está hecho cuando:

- el webhook verifica la firma sobre el cuerpo crudo y rechaza el resto;
- el `user_id` del evento coincide con el `composioUserId` del workspace, si no se descarta;
- el mismo id de evento no dispara dos tareas;
- hay un worker de `integration.event` que abre una Task o aplica el efecto de dominio que el trigger declare.

### `crm.sync`

Está hecho cuando:

- si el workspace no tiene `settings.crmSync`, no se encola trabajo;
- el worker hace upsert por `ExternalLink` y Composio, sin cliente propio de Holded o HubSpot;
- un fallo queda visible en la Task o en el lead y no se reintenta a ciegas un alta ya hecha;
- los logs no llevan tokens.

### Plantillas de WhatsApp

Está hecho cuando:

- fuera de la ventana de 24 h, Cloud API solo envía una plantilla aprobada;
- el agente no puede inventar el nombre de una plantilla que el número no tenga;
- Baileys no simula plantillas de Meta.

### Embedded Signup

Está hecho cuando:

- se puede conectar una cuenta de WhatsApp Business sin pegar un token permanente en la UI;
- el token queda en el vault, cifrado y ligado a la conexión;
- un workspace no puede usar el token de otro.

## E10. Delegación — hecho

Está hecho cuando:

- `delegate_task` crea una Task hija y la padre queda en `WAITING_CHILD` hasta que la hija termina;
- la profundidad no pasa de 3;
- el costo de la hija suma al de la padre y respeta el cupo;
- un handoff de conversación de WhatsApp sigue siendo transferencia de hilo, no una Task hija;
- una cara externa no delega tools internas.

## E11. Temporal

No está en el corte. No lo empieces por anticipado.

Está hecho cuando:

- un criterio del ADR 004 está medido y anotado en ese ADR (fecha y número);
- el adaptador nuevo implementa el mismo puerto;
- el loop es una activity y el workflow guarda estado y checkpoints, con los datos del cliente todavía en Postgres;
- el servicio corre en Hetzner, en la UE.

## Fuera de esta lista

- Acoplar Everglow con Studio o con Galatea.
- Un diseñador de flujos como producto.
- Proveedores de LLM sin región UE.
- Instagram, ejecutores en el dispositivo y sandbox: siguen en `spec-v3/specs/30-futuro.md`.
