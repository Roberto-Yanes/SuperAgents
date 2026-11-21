# 00. Visión y alcance

## Qué es

Un **motor multiagente** que un negocio (pyme) deja corriendo 24/7. El dueño arma agentes (o instala una plantilla de su rubro), los conecta a sus canales (WhatsApp, email) y a cualquier app del negocio a través de Composio (Google Calendar, Holded, Gmail, HubSpot y más de 1800 toolkits) y los agentes:

- atienden clientes por WhatsApp (y luego Instagram) con una **cara externa** acotada;
- agendan turnos en Google Calendar;
- crean y mueven leads en el embudo propio y los reflejan en el CRM del negocio (Holded u otro);
- hacen seguimientos multicanal programados;
- ejecutan rutinas (todos los lunes, resumen de leads; cada mañana, recordatorios);
- conversan con el dueño por su **cara interna** (chat estilo Grok Bot) y se delegan trabajo entre ellos en equipos.

## MVP 1 (paridad Auryx)

| Capacidad | Incluye |
|---|---|
| Atención WhatsApp | Inbound y respuesta por agente externo, horario, derivación humana (takeover), canal **Baileys** hoy y **Cloud API** cuando Meta apruebe (adaptadores intercambiables) |
| Agenda | Disponibilidad (freeBusy), proponer slots, reservar, reprogramar, cancelar, recordatorios |
| Leads | Captura y calificación por el agente, embudo propio, espejo opcional en el CRM conectado por Composio (Holded, HubSpot…) |
| Seguimientos | Secuencias por WhatsApp y email; se cortan si el contacto responde |
| Rutinas | Disparadores CRON, evento y webhook entrante |
| Plantillas por rubro | Instalan agentes, tools, FAQ, secuencias y horarios en minutos |
| Chat del dueño | Chat con cada agente, streaming, archivos, aprobaciones |
| Equipos | Coordinador, handoff y delegación de tareas |
| API pública | Todo lo anterior expuesto para la UI externa |

## Fuera del MVP 1

- La UI (se construye aparte contra la API).
- Instagram y Messenger (F9, adaptador ya previsto).
- Multitenant real (registro abierto, facturación, aislamiento estricto): el modelo ya lo soporta, se activa después.
- Ejecutores de dispositivo (navegador o archivos en la PC del usuario) y sandbox en la nube (OpenSandbox): interfaz prevista, implementación posterior.
- Voz y llamadas.

## Principios

1. **Headless y API-first**: nada de lógica en la UI; si la UI lo necesita, existe un endpoint.
2. **Un proceso que nunca duerme**: el motor no depende de que haya un cliente conectado.
3. **Todo efecto externo es idempotente y auditable** (mensajes, turnos, leads).
4. **Las reglas viven en código**; el LLM decide qué tool llamar, no las reglas del negocio críticas (horarios, ventana de 24 h, límites).
5. **Simple para un desarrollador con agentes de IA**: un monorepo TypeScript, Postgres como única dependencia de infraestructura.
