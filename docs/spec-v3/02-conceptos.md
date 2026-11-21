# 02. Conceptos

| Concepto | Qué es | Notas |
|---|---|---|
| **Workspace** | El negocio. Raíz de todos los datos | MVP: uno solo; todas las tablas tienen `workspaceId` |
| **User / Member** | Persona que usa la UI; `Member` la vincula al workspace con un rol | Roles: `OWNER`, `ADMIN`, `OPERATOR` (atiende inbox) |
| **ApiKey** | Credencial para integraciones y la UI headless | Scopes (`agents:read`, `chats:write`…), hash SHA-256 |
| **Agent** | Unidad que razona y actúa | Ver configuración abajo |
| **Team** | Grupo de agentes con un coordinador | Delegación y handoff dentro del equipo |
| **Tool** | Capacidad que un agente puede invocar | Definida en código; el agente la habilita con `AgentTool` |
| **Connection** | Cuenta de una app de terceros conectada por Composio (= *connected account* de Composio): Holded, Google Calendar, Gmail, HubSpot… | Guardamos `composioConnectedAccountId`, `toolkit` y `status`; los tokens o API keys los custodia Composio. Dueño: el negocio (`ws_<id>:integration`) o un miembro (`ws_<id>:user_<id>`) |
| **Credential** | Secreto propio que no pasa por Composio: clave de LLM, SMTP | Cifrado en nuestro vault (`Secret`) |
| **AppTool** | Acción de Composio habilitada en el workspace y publicada como tool (`app.holded.create_contact`) | Lleva nuestras reglas: scope, riesgo, aprobación, versión fijada del toolkit |
| **Channel** | Punto de contacto con clientes (un número de WhatsApp, una casilla) | `provider` intercambiable: `BAILEYS` o `META_CLOUD` |
| **Contact** | Persona externa (cliente o prospecto) | Varias `ContactIdentity` (teléfono, email, IG) |
| **Conversation** | Hilo de mensajes | `EXTERNAL` (contacto por canal) o `INTERNAL` (usuario con agente) |
| **Message** | Mensaje entrante o saliente | Rol: `CONTACT`, `AGENT`, `HUMAN`, `USER`, `SYSTEM`, `TOOL` |
| **Lead** | Oportunidad comercial ligada a un contacto | Embudo propio; espejo opcional en el CRM que elija el negocio (Holded, HubSpot…) vía Composio y `ExternalLink` |
| **Run** | Una ejecución de agente (responder, cumplir una tarea, una rutina) | Estados en `06-confiabilidad.md` |
| **RunStep** | Paso del run: llamada LLM, tool, delegación, mensaje | Checkpoint para reanudar |
| **Task** | Trabajo asignado (por el dueño o por otro agente) que produce runs | `delegate_task` crea una Task hija |
| **Routine** | Disparador programado o por evento que crea Tasks | `CRON`, `EVENT`, `WEBHOOK` |
| **Sequence** | Seguimiento multicanal en pasos con espera | `Enrollment` por contacto; se corta si responde |
| **Approval** | Pedido de autorización humana antes de un efecto | Persistido; pausa el run |
| **Memory** | Hechos recordados (por contacto, por agente, del workspace) | Escritos por tool `remember` o al cerrar conversaciones |
| **KnowledgeSource** | FAQ, precios, documentos del negocio | Chunks con embeddings (RAG) |
| **Template** | Paquete instalable por rubro | Crea agentes, tools, secuencias, FAQ, horarios |
| **Event** | Hecho del sistema con `seq` monotónica | Alimenta WS, auditoría y disparadores EVENT |

## Configuración de un agente

```ts
type AgentConfig = {
  name: string;
  role: string;                  // "Recepcionista", "Vendedor", "Asistente del dueño"
  avatar?: string;
  face: 'EXTERNAL' | 'INTERNAL' | 'BOTH';
  systemPrompt: string;          // instrucciones (render desde plantilla con variables)
  model: { provider: 'openai' | 'anthropic' | 'google' | 'ollama' | 'lmstudio'; model: string; temperature?: number };
  tools: { key: string; approval?: ApprovalPolicy; config?: Record<string, unknown> }[];
  channels: string[];            // channelIds que atiende (solo cara externa)
  knowledgeSourceIds: string[];
  schedule?: BusinessHours;      // horario de atención; fuera de horario: mensaje fijo o derivar
  limits: { maxStepsPerRun: number; maxConcurrentRuns: number; dailyBudgetUsd?: number };
  handoffTargets?: string[];     // agentes a los que puede derivar
};
```

## Caras del agente

| | EXTERNAL | INTERNAL |
|---|---|---|
| Con quién habla | Contactos por un canal | Usuarios del workspace por la UI o API |
| Tools | Solo `scope: external` (agenda, leads del contacto actual, FAQ, derivar a humano) | Todas las habilitadas (`internal` y `external`) |
| Datos visibles | Solo el contacto y la conversación actual, la base de conocimiento | Todo el workspace según permisos del usuario |
| Aprobaciones | Las decide el dueño u operador, nunca el contacto | Las decide el usuario que chatea o el dueño |
| Ejemplos | Recepcionista de WhatsApp | "Pasame los leads calientes de la semana" |

Un mismo agente puede tener ambas caras (`BOTH`), pero el runtime arma **contextos y listas de tools distintas** según el tipo de conversación (ver `07-seguridad.md`).

## Tools

```ts
type ToolDef<I, O> = {
  key: string;                         // "calendar.book"
  description: string;
  input: ZodSchema<I>;
  output: ZodSchema<O>;
  scope: 'internal' | 'external';      // external = puede usarse frente a un contacto
  risk: 'read' | 'write' | 'send' | 'money' | 'delete';
  defaultApproval: 'NEVER' | 'ASK_OWNER' | 'ALWAYS';
  requires?: { toolkit?: string; executor?: 'server' | 'device' | 'sandbox' }; // toolkit de Composio, p. ej. 'googlecalendar'
  idempotent: boolean;                 // si true, el runtime le pasa idempotencyKey
  handler: (input: I, ctx: ToolContext) => Promise<O>;
};
```

Catálogo MVP (tools nativas; `calendar.*` y la sync de leads se apoyan en acciones de Composio por dentro):

| Tool | Scope | Riesgo | Aprobación default | Spec |
|---|---|---|---|---|
| `kb.search` | external | read | NEVER | 21 |
| `memory.remember` / `memory.recall` | internal (recall: external sobre el contacto actual) | write/read | NEVER | 21 |
| `calendar.check_availability` | external | read | NEVER | 17 |
| `calendar.book` / `calendar.reschedule` / `calendar.cancel` | external | write | NEVER | 17 |
| `leads.upsert` / `leads.move_stage` | external (contacto actual) | write | NEVER | 18 |
| `leads.search` | internal | read | NEVER | 18 |
| `contacts.search` / `conversations.read` | internal | read | NEVER | 15 |
| `handoff.to_human` | external | write | NEVER | 15 |
| `messages.send` (a otro contacto) | internal | send | ASK_OWNER | 14 |
| `sequences.enroll` / `sequences.stop` | internal | send | ASK_OWNER | 19 |
| `email.send` | internal | send | ASK_OWNER | 19 |
| `team.handoff_to_agent` / `team.delegate_task` | según equipo | write | NEVER | 20 |
| `docs.generate` (PDF, DOCX, XLSX) | internal | write | NEVER | 11 |
| `app.<toolkit>.<acción>` (cualquier acción de Composio habilitada) | internal por defecto | según la acción | lectura `NEVER`, escritura `ASK_OWNER`, borrado `ALWAYS` | 16 |

## Tools de apps (Composio)

El registro de tools tiene dos fuentes: las **nativas** (código del repo) y las **de apps**, que publica `ComposioGateway` a partir de `AppTool`. Una tool de app es un `ToolDef` más:

```ts
// generado por ComposioGateway a partir de AppTool + schema de Composio
{
  key: 'app.holded.create_contact',
  description: 'Crea un contacto en Holded…',        // de Composio, editable
  input: zodFromJsonSchema(appTool.inputSchema),
  scope: appTool.scope,                               // 'internal' salvo que el dueño marque 'external'
  risk: appTool.risk,                                 // inferido del slug (GET/FIND/LIST → read, DELETE → delete) y editable
  defaultApproval: appTool.defaultApproval,
  requires: { toolkit: 'holded' },
  idempotent: false,                                  // escrituras: outbox con clave propia
  handler: (input, ctx) => composioGateway.execute(ctx.workspaceId, ctx.actor, 'HOLDED_CREATE_CONTACT', input),
}
```

El gateway elige la `Connection` (la del negocio por defecto, o la del miembro si la tool corre en su chat interno). Si falta la conexión o está `NEEDS_REAUTH`, la tool se oculta y `GET /v1/tools` lo informa (`missingConnection`). El agente nunca ve Connect Links ni puede conectar cuentas: eso lo hace un humano por la API.

## Políticas de aprobación

`NEVER` (ejecuta), `ASK_OWNER` (pausa hasta que un OWNER/ADMIN decida), `ALWAYS` (siempre pide, incluso en chat interno). El override por agente va en `AgentTool.approval`. Una aprobación vencida cancela la acción, nunca la ejecuta.
