# Plataforma multiagente headless (docs-v3)

Diseño original del motor. La dirección vigente está en `docs/adr/` y `docs/ROADMAP.md`. Si este árbol dice que el producto es un flujo fijo o solo WhatsApp, gana el ADR 003: el agente recibe un objetivo, investiga, planifica y ejecuta. WhatsApp es un canal. Las secuencias y las plantillas son atajos. Los modelos de clientes europeos van en la UE (ADR 005). everglow-agentes es de Everglow; no lo acoples a Studio (Galatea).

Motor y backend de agentes de IA para un negocio: tareas autónomas, atención por WhatsApp, agenda, leads, seguimientos, rutinas y chat del dueño con sus agentes. **Headless**: no trae UI. La app (desktop, web o móvil) es un cliente aparte que se conecta por la **API pública** (REST + WebSocket + SSE). “Estilo Grok Bot” más abajo nombra esa forma de chat, no el modelo de xAI, que no está permitido.

- Corre como **proceso de servidor de larga vida** (Docker) en un VPS, una PC o una mini PC: los agentes trabajan 24/7 aunque no haya ninguna UI abierta.
- **Un workspace primero**, pero todas las entidades llevan `workspaceId` y todo acceso pasa por sesión o API key: pasar a multitenant es habilitar un switch, no reescribir.
- Reemplaza a docs-v2 (app híbrida) y a los análisis de Tropa. Se porta código de Tropa v2 donde conviene (ver `08-stack-y-repo.md`).

Estado: **propuesta lista para implementar**. Lo no confirmado está marcado ⚠ VERIFICAR.

## Índice

| Doc | Contenido |
|---|---|
| [00-vision-y-alcance.md](00-vision-y-alcance.md) | Qué es, capacidades del motor, fuera de alcance |
| [01-arquitectura.md](01-arquitectura.md) | Componentes, despliegue, procesos |
| [02-conceptos.md](02-conceptos.md) | Workspace, Agente, Tool, Canal, Run, Aprobación, etc. |
| [03-modelo-de-datos.md](03-modelo-de-datos.md) | Esquema Prisma (validado) |
| [04-api-publica.md](04-api-publica.md) | Contrato REST, WebSocket, SSE, auth |
| [05-flujos.md](05-flujos.md) | Diagramas de secuencia clave |
| [06-confiabilidad.md](06-confiabilidad.md) | Idempotencia, reintentos, checkpoints, concurrencia |
| [07-seguridad.md](07-seguridad.md) | Secretos, permisos de tools, caras interna/externa |
| [08-stack-y-repo.md](08-stack-y-repo.md) | Stack, layout del repo, qué se reutiliza |
| [09-roadmap.md](09-roadmap.md) | Fases con semanas |
| [90-decisiones.md](90-decisiones.md) | ADRs |
| [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) | Reglas para agentes de código |

### Specs (tareas para Codex, Claude Code o Kimi)

| Spec | Módulo | Fase |
|---|---|---|
| [specs/10-fundaciones.md](specs/10-fundaciones.md) | Monorepo, Docker, DB, auth, esqueleto API, eventos | F0 |
| [specs/11-runtime-de-agentes.md](specs/11-runtime-de-agentes.md) | LLM multi-proveedor, tools, loop, runs | F1 |
| [specs/12-api-y-streaming.md](specs/12-api-y-streaming.md) | API pública, SSE, WS, SDK | F1 |
| [specs/13-aprobaciones.md](specs/13-aprobaciones.md) | Políticas y flujo de aprobación | F1 |
| [specs/14-canales-y-whatsapp.md](specs/14-canales-y-whatsapp.md) | Framework de canales, Baileys, Cloud API | F2 |
| [specs/15-inbox-y-contactos.md](specs/15-inbox-y-contactos.md) | Contactos, conversaciones, takeover | F2 |
| [specs/16-composio-y-vault.md](specs/16-composio-y-vault.md) | Composio Gateway (conexiones, acciones como tools, triggers) y vault propio | F2 |
| [specs/17-agenda.md](specs/17-agenda.md) | Agenda (Google Calendar vía Composio) | F3 |
| [specs/18-leads-y-crm.md](specs/18-leads-y-crm.md) | Leads, embudo, CRM espejo (Holded vía Composio) | F4 |
| [specs/19-cola-rutinas-y-seguimientos.md](specs/19-cola-rutinas-y-seguimientos.md) | pg-boss, rutinas, secuencias, email | F5 |
| [specs/20-equipos-y-delegacion.md](specs/20-equipos-y-delegacion.md) | Equipos, handoff, delegate | F6 |
| [specs/21-memoria-y-rag.md](specs/21-memoria-y-rag.md) | Memoria, base de conocimiento | F7 |
| [specs/22-plantillas-por-rubro.md](specs/22-plantillas-por-rubro.md) | Plantillas instalables | F7 |
| [specs/23-observabilidad-y-deploy.md](specs/23-observabilidad-y-deploy.md) | Logs, auditoría, métricas, backups | F8 |
| [specs/30-futuro.md](specs/30-futuro.md) | Instagram, multitenant, ejecutores de dispositivo y sandbox | Post-MVP |

## Cómo usar las specs con un agente de código

1. Abrí la sesión en la raíz del repo (el agente lee `AGENTS.md`; Claude Code lee `CLAUDE.md`, que lo referencia).
2. Pegá **una tarea por vez** (`Txx.y`) con este prompt:

```text
Implementá la tarea <Txx.y> de docs/specs/<archivo>.md.
Leé antes: AGENTS.md y los docs listados en "Leer" de la tarea.
Respetá "No hacer". Al terminar: pnpm typecheck && pnpm test, y resumí archivos cambiados.
```

3. Si la tarea es un port de Tropa, agregá: `Modo port. Origen (solo lectura): ../tropa-desktop/<archivo>`.
4. Revisá el diff y cerrá la tarea antes de pasar a la siguiente.
