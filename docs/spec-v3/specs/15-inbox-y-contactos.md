# 15. Inbox, contactos y cara externa (F2)

### T15.1. Ruteo de inbound
- **Hacer**: handler de `channel.inbound`: busca o crea `Conversation EXTERNAL` (por canal y contacto), actualiza `lastInboundAt`; si `status = HUMAN`, solo emite eventos; si fuera de horario del agente, responde mensaje configurado; si no, debounce de 2 s y encola `run.execute` con el agente asignado (`Conversation.agentId` o `Channel.defaultAgentId` o `AgentChannel` por prioridad).
- **Hecho cuando**: tests de cada rama.

### T15.2. Cara externa en el runtime
- **Leer**: `docs/07-seguridad.md`.
- **Hacer**: tools filtradas a `scope: external`; `ToolContext.contactId` obligatorio; prompt con reglas fijas (identificarse como asistente del negocio, ofrecer humano). La respuesta final sale por `messages.reply` interno vía outbox.
- **Hecho cuando**: test de inyección: el contacto pide datos de otro cliente y la tool no los devuelve.

### T15.3. Tool handoff.to_human
- **Hacer**: pasa la conversación a `PENDING_HUMAN`, avisa por evento (y push en la UI), responde al contacto un texto configurable.
- **Hecho cuando**: test.

### T15.4. API de inbox
- **Leer**: `docs/04-api-publica.md` (Inbox).
- **Hacer**: listar y filtrar, detalle, `takeover`, `release`, `close`, mensaje humano (por outbox, respeta ventana).
- **Hecho cuando**: tests; mientras está en `HUMAN`, un inbound no dispara runs.

### T15.5. Contactos
- **Hacer**: CRUD, identidades, tags, opt-out, `timeline`, borrado en cascada; normalización de teléfono con `libphonenumber-js` y país por defecto del workspace.
- **Hecho cuando**: tests de normalización y de merge simple por identidad repetida.
