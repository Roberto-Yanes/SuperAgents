# 20. Equipos y delegación (F6)

**Modo port** (reglas): `../tropa-desktop/engine.mjs` (`collaborate`, contactos permitidos, límite de consultas por mensaje).

### T20.1. Equipos
- **Hacer**: CRUD `/v1/teams` con coordinador y `canDelegateTo`; chat con un equipo (`POST /v1/chats` con `teamId` → habla el coordinador).
- **Hecho cuando**: tests.

### T20.2. team.delegate_task
- **Hacer**: crea `Task` hija asignada, `Run DELEGATION`, pone el padre en `WAITING_CHILD`; al terminar la hija, `run.resume` del padre con el resultado; profundidad máxima 3 y máximo 6 delegaciones por run.
- **Hecho cuando**: test coordinador → 2 agentes → respuesta final.

### T20.3. team.handoff_to_agent
- **Hacer**: transfiere `Conversation.agentId` a otro agente permitido (externo → externo), con nota de contexto; evento `conversation.updated`.
- **Hecho cuando**: test en conversación de WhatsApp fake.

### T20.4. Visibilidad
- **Hacer**: eventos `delegation` en el stream del padre; `GET /v1/runs/:id` muestra el árbol de subtareas.
- **Hecho cuando**: test.
