# 13. Aprobaciones (F1)

### T13.1. Servicio
- **Leer**: `docs/02-conceptos.md` (Políticas), `docs/05-flujos.md` (Aprobación).
- **Hacer**: `packages/core/approvals`: `resolvePolicy(toolDef, agentTool, face)`, `request(run, step, summary, payload, ttl)`, `decide(id, decision, actor, editedPayload?)`, `expire()`.
- **Hecho cuando**: tests de política (override por agente, `ALWAYS` en interno).

### T13.2. Integración con el runtime
- **Hacer**: el loop pausa en `WAITING_APPROVAL`; al decidir se encola `run.resume` con `singletonKey = approvalId`; rechazada o vencida se informa al LLM como resultado de tool.
- **Hecho cuando**: test de extremo a extremo aprobar, rechazar y vencer.

### T13.3. API y eventos
- **Hacer**: `GET /v1/approvals`, `POST /v1/approvals/:id/decide` (solo OWNER o ADMIN, o el usuario del chat interno), eventos `approval.requested` y `approval.decided`, cola `approval.expire` (cada minuto).
- **Hecho cuando**: tests de permisos y de doble decisión (409).
