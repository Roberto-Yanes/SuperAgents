# 18. Leads, embudo y CRM espejo (F4)

Base: spec 14 de docs-v2 (embudo y reglas). El embudo vive en nuestra base. El espejo en un CRM externo es **genérico** (`ExternalLink`) y va por Composio (ADR-014). Holded es el primer mapeo.

Verificado en el catálogo de Composio (21/11/2026): toolkit `HOLDED`, auth `API_KEY`, 10 acciones y 0 triggers. Las acciones son `HOLDED_CREATE_CONTACT`, `HOLDED_FIND_CONTACTS`, `HOLDED_GET_CONTACT`, `HOLDED_UPDATE_CONTACT`, `HOLDED_DELETE_CONTACT`, `HOLDED_CREATE_INVOICE`, `HOLDED_FIND_INVOICES`, `HOLDED_GET_INVOICE`, `HOLDED_UPDATE_INVOICE` y `HOLDED_DELETE_INVOICE`. **No hay acciones de leads, embudos ni etapas del CRM de Holded.**

### T18.1. Embudo y servicio de leads
- **Hacer**: `Pipeline` y `Stage` por defecto al crear el workspace; `leads.upsert(contactId, data)`, `leads.move(id, stageId)`; eventos `lead.updated`.
- **Hecho cuando**: tests.

### T18.2. Tools
- **Hacer**: `leads.upsert` y `leads.move_stage` (externas, atadas al contacto actual), `leads.search` (interna).
- **Hecho cuando**: test de calificación en una conversación con LLM fake.

### T18.3. API
- **Hacer**: `/v1/pipelines` (incluye `syncConnectionId` y el mapeo de etapas), `/v1/leads`, `/v1/leads/:id/move`.
- **Hecho cuando**: tests.

### T18.4. Puerto CRM y mapeo Holded
- **Hacer**: `CrmPort` con `upsertContact`, `upsertLead`, `moveStage`, `listStages`. Implementación `holded`:
  - Contactos: `HOLDED_FIND_CONTACTS` por email o teléfono, y después `HOLDED_CREATE_CONTACT` o `HOLDED_UPDATE_CONTACT`.
  - Leads y etapas: **Proxy Execute** con la misma conexión de Holded, con rutas fijas en código hacia la API de CRM de Holded ([crear lead](https://www.holded.com/developers/api-reference/leads/create-a-lead), [cambiar etapa](https://www.holded.com/developers/api-reference/leads/update-a-lead-stage)) ⚠ VERIFICAR que Proxy Execute funcione con la conexión `API_KEY` de Holded y las rutas vigentes.
  - Si Proxy Execute no sirve: registrar el MCP oficial de Holded (`https://mcp.holded.com/mcp`, OAuth con DCR) como Custom MCP en Composio y usar sus tools de CRM ⚠ VERIFICAR que ese MCP exponga leads.
  - Mapeo de etapas en `ExternalLink` (`entityType = STAGE`).
  - Otro CRM con toolkit en Composio (HubSpot, Pipedrive…) es otra implementación de `CrmPort`, sin cambios de modelo.
- **Hecho cuando**: tests con fake de `AppGateway`.

### T18.5. Sincronización
- **Hacer**: job `crm.sync` por lead (outbox, `singletonKey = leadId`) cuando el pipeline tiene `syncConnectionId`: upsert de contacto, upsert de lead y movimiento de etapa; guarda IDs en `ExternalLink`; reintentos en 429 y 5xx (los de Composio y los de la app).
- **Hecho cuando**: test: un lead creado en una conversación aparece en el fake una sola vez, y moverlo de etapa no crea otro.
