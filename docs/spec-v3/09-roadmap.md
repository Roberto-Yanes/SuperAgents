# 09. Roadmap

Este calendario era el camino a la paridad de capacidades del primer corte. Ya no es el orden de trabajo. El backlog vigente, con criterios de aceptación, está en `docs/ROADMAP.md` (Task autónoma, puerto de jobs, LLM en la UE, y los pendientes M9, `crm.sync`, RAG, plantillas de WhatsApp y Embedded Signup).

Un desarrollador con agentes de código. Las semanas de abajo son historia, no un plan.

| Fase | Contenido | Specs | Semanas | Acumulado |
|---|---|---|---|---|
| **F0. Fundaciones** | Monorepo, Docker Compose, Prisma, extensión de workspace, Better Auth, API keys, esqueleto de API, eventos, pg-boss arrancado | 10 | 1,5 | 1,5 |
| **F1. Runtime y chat interno** | Capa LLM, registro de tools, loop con checkpoints, runs, chat por API con SSE y WS, aprobaciones, SDK inicial | 11, 12, 13 | 2,5 | 4 |
| **F2. WhatsApp, inbox y Composio** | Framework de canales, adaptador Baileys (port de Tropa), adaptador Cloud API, ruteo, cara externa, contactos, takeover; vault propio (solo LLM, SMTP, Meta); **Composio Gateway**: catálogo, Connect Link y callback, `AppTool`, webhook de triggers | 14, 15, 16 | 2,5 | 6,5 |
| **F3. Agenda** | Slots en código, tools de agenda sobre acciones de Google Calendar en Composio, recordatorios | 17 | 0,5 | 7 |
| **F4. Leads y CRM espejo** | Embudo propio, tools de leads, sync genérica (`ExternalLink`) con mapeo para Holded vía Composio | 18 | 1 | 8 |
| **F5. Rutinas y seguimientos** | Rutinas CRON, EVENT, WEBHOOK y por trigger de Composio; secuencias WhatsApp y email (SMTP o Gmail vía Composio) | 19 | 1,5 | 9,5 |
| **F6. Equipos** | Coordinador, handoff, delegate_task | 20 | 1 | 10,5 |
| **F7. Memoria, RAG y plantillas** | Base de conocimiento, memoria, 3 o 4 plantillas por rubro | 21, 22 | 1,5 | 12 |
| **F8. Producción** | Observabilidad, backups, hardening, piloto | 23 | 1 | **13** |
| F9 (post-MVP) | Instagram y Messenger, multitenant, ejecutores device y sandbox | 30 | — | — |

Hitos de demo:
- **Semana 4**: chat con un agente por API con streaming y tools internas (la UI externa puede empezar a integrarse).
- **Semana 6,5**: un agente atiende WhatsApp real (Baileys) y el dueño toma conversaciones.
- **Semana 9,5**: paridad funcional con Auryx salvo plantillas.
- **Semana 13**: piloto.

**Cambio respecto de la versión anterior (ADR-014)**:
- Agenda baja de 1 a 0,5 semanas: no hay OAuth propio con Google ni cliente de Calendar, solo el cálculo de slots y el mapeo a acciones de Composio.
- Leads baja de 1,5 a 1: no hay cliente de Holded ni limitador propio, solo la sync genérica y el mapeo.
- El trabajo de OAuth y vault de F2 se reemplaza por el Composio Gateway, a costo similar.
- Total: de 14 a 13 semanas, y cada app nueva del catálogo de Composio (HubSpot, Sheets, Outlook…) pasa a ser configuración.

Trámites en paralelo desde la semana 1: aprobación de Meta (Tech Provider, en curso), cuenta de Composio con un proyecto por entorno (Hobby alcanza para el MVP), dominio y TLS del servidor. La verificación de OAuth de Google solo hace falta si se pasa a una app OAuth propia (white-label) y se superan 100 usuarios ([Google](https://support.google.com/googleapi/answer/7454865)).
