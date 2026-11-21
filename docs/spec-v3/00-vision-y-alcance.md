# 00. Visión y alcance

> Dirección vigente, confirmada por Roberto. El detalle está en `docs/adr/003-runtime-agentes-autonomos.md`, `docs/adr/004-motor-jobs-pgboss-temporal.md` y `docs/adr/005-llm-residencia-ue.md`. Si este archivo discute con esos ADR, mandan los ADR.

## Qué es

everglow-agentes es el producto de **Everglow**. Studio es de Galatea: no comparten código, auth, base ni claves. No los acoples.

Es un motor para que un negocio automatice tareas con **agentes autónomos**. El agente recibe una instrucción o un objetivo, investiga, arma un plan, usa tools y ejecuta. Se parece a un asistente personal. No es un conjunto de flujos predefinidos.

WhatsApp es **un canal**: el agente que contesta. El resto se dispara desde la app.

Los clientes son europeos (España). Hace falta RGPD, residencia de datos en la UE y poder auditar el uso de IA. Los LLM son BYOK y tienen que procesar en la UE (Azure OpenAI en región UE, Mistral, un modelo hospedado en la UE). Grok y cualquier proveedor sin procesamiento en la UE no se usan. “Chat estilo Grok Bot” en textos viejos de esta spec nombra la forma de la UI, no ese modelo.

El dueño arma agentes (o instala una plantilla como punto de partida), los conecta a WhatsApp, al email y a las apps del negocio por Composio, y los agentes:

- contestan clientes por WhatsApp con una **cara externa** acotada;
- toman un objetivo de seguimiento de leads y deciden si anotan, mueven el embudo, esperan o usan una secuencia;
- generan contenido (un borrador) y piden permiso para publicar o enviar;
- ejecutan tareas lanzadas desde la app, aunque no haya un chat de WhatsApp abierto;
- conversan con el dueño por la **cara interna** y, si el objetivo lo pide, delegan en otro agente.

Las secuencias, las rutinas y las plantillas por rubro son tools o semillas. No son el recorrido fijo del negocio.

## Capacidades del motor (el primer corte, paridad Auryx)

Esta tabla es lo que el motor ya sabía hacer o tenía diseñado como primer corte. No define el producto: el producto es la Task del ADR 003. El orden para llegar ahí está en `docs/ROADMAP.md`.

| Capacidad | Incluye |
|---|---|
| Atención WhatsApp | Un canal. Inbound y respuesta por agente externo, horario, derivación humana (takeover), canal **Baileys** hoy y **Cloud API** cuando Meta apruebe (adaptadores intercambiables) |
| Agenda | Disponibilidad (freeBusy), proponer slots, reservar, reprogramar, cancelar, recordatorios |
| Leads | Captura y calificación por el agente, embudo propio, espejo opcional en el CRM conectado por Composio (Holded, HubSpot…) |
| Seguimientos | El agente cumple un objetivo sobre un lead. Una secuencia por WhatsApp o email es una tool, y se corta si el contacto responde |
| Rutinas | Disparadores CRON, evento y webhook que abren una Task, no un guion |
| Plantillas por rubro | Instalan un agente de partida (tools, FAQ, horarios). No instalan el flujo del negocio |
| Chat del dueño y tareas de la app | Chat con cada agente, streaming, archivos, aprobaciones, y objetivos que no pasan por WhatsApp |
| Equipos | Coordinador, handoff y delegación de tareas |
| API pública | Todo lo anterior expuesto para la UI externa |

## Fuera de este corte

- La UI (se construye aparte contra la API). No es este repo y no es Studio.
- Instagram y Messenger (adaptador ya previsto).
- Multitenant comercial (registro abierto, facturación): el modelo ya aísla por `workspaceId`.
- Ejecutores de dispositivo y sandbox en la nube: interfaz prevista, implementación posterior.
- Voz y llamadas.
- Temporal, hasta que se mida un criterio de `docs/adr/004-motor-jobs-pgboss-temporal.md`.
- Cualquier LLM sin región UE.

## Principios

1. **Headless y API-first**: nada de lógica en la UI; si la UI lo necesita, existe un endpoint.
2. **Un proceso que nunca duerme**: el motor no depende de que haya un cliente conectado.
3. **Todo efecto externo es idempotente y auditable** (mensajes, turnos, leads).
4. **Las reglas viven en código**; el LLM elige el plan y las tools, no las reglas que no se negocian (horarios, ventana de 24 h, cupos, región del modelo, piso de riesgo).
5. **Simple para un desarrollador con agentes de IA**: un monorepo TypeScript, Postgres como única dependencia de infraestructura mientras el motor de jobs sea pg-boss.
6. **Datos de clientes europeos en la UE**, con auditoría de modelo, región, tool y decisión.
