# Roadmap hacia el MVP (paridad Auryx)

Orden pensado para tener un piloto vendible cuanto antes. ✅ = hecho (21/11/2026).

Hecho en la segunda pasada: inbox y takeover (4), agenda con recordatorio (6, sin Google Calendar), leads (7, sin el adaptador `crm.sync`), secuencias y rutinas con sus workers (8) y coste por run más `/metrics` (11). Composio (5) ejecuta la lista blanca con una sola key de servidor; los triggers siguen pendientes. Siguen fuera: RAG (9), plantillas por rubro (10), plantillas de WhatsApp fuera de la ventana de 24 h, Embedded Signup y `integration.event`.

| #        | Módulo                  | Capa               | Qué incluye                                                                                    | Depende de          |
| -------- | ----------------------- | ------------------ | ---------------------------------------------------------------------------------------------- | ------------------- |
| 1        | Conexiones              | access + domain    | `/v1/connections` (alta con secreto cifrado, prueba, estado), conexiones LLM operativas        | —                   |
| 2        | WebSocket con tickets   | access             | `/v1/ws`: ticket de un solo uso emitido por la API; mismo bus que SSE                          | —                   |
| 3        | Canal WhatsApp          | integrations       | Adaptador Baileys (piloto) y Cloud API (producción), webhook firmado, ventana 24 h, plantillas | 1                   |
| 4        | Inbox y takeover        | domain + access    | Tomar, liberar y responder como humano; listado de conversaciones con filtros                  | 3                   |
| 5        | Composio Gateway        | integrations       | Acciones habilitadas por workspace como ToolDef, triggers → `integration.event`                | 1                   |
| 6        | Agenda y turnos         | domain             | Huecos calculados en código, reserva con doble comprobación, `appointment.reminder`            | 5 (Google Calendar) |
| 7        | Leads y embudo          | domain             | Etapas, captura desde conversación, `crm.sync` con HubSpot/Holded vía Composio                 | 5                   |
| 8        | Secuencias y rutinas    | domain + execution | `sequence.step` y `routine.cron` (pg-boss schedule con zona horaria)                           | 3                   |
| 9        | Memoria y RAG           | orchestration      | Embeddings en pgvector, base de conocimiento por workspace, búsqueda híbrida                   | —                   |
| 10       | Plantillas por rubro    | domain             | Agente + tools + aprobaciones + secuencias listos por sector                                   | 6, 7, 8             |
| 11       | Métricas y costes       | shared             | Coste por run y por workspace, métricas Prometheus                                             | —                   |
| Post-MVP | Orquestador multiagente | orchestration      | Equipos, coordinador, `delegate_task`, handoff entre agentes                                   | 9                   |
| Post-MVP | Ejecutores enchufables  | integrations       | Runtime local en el PC, OpenSandbox                                                            | —                   |
