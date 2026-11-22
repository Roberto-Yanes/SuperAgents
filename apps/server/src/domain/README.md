# domain/ — Capa 04 · Dominio / negocio

Reglas del negocio sin HTTP, sin proveedores de IA y sin adaptadores. Cada subcarpeta es un módulo con su `service.ts`.
Cuando necesita algo de fuera, define un **puerto** (interfaz) que otra capa implementa: p. ej. `ToolNameChecker` en `agents/service.ts`, `ConnectionTester` en `connections/service.ts`.

```
domain/
  agents/service.ts         CRUD de agentes, validación de tools, versionado y auditoría
  contacts/service.ts       Contacto por id de canal (upsert)
  connections/kinds.ts      Catálogo de tipos de conexión: configuración y secreto validados por tipo
  connections/service.ts    Alta, actualización, prueba (testers inyectados) y lectura de secretos cifrados
  conversations/service.ts  Punto único de entrada de mensajes: dedupe, takeover humano, creación y encolado del run; estados de entrega
  runs/service.ts           Consultas de runs para la API
  connections/llm-residency.ts  ADR 005: proveedores y regiones UE, política del workspace (al guardar y al usar)
  tasks/service.ts          Tareas (ADR 003): crear desde la app, listar, cancelar en cascada, ampliar cupo, mandar un dato
  tasks/limits.ts           Cupos: defaults por puerta, techo de la plataforma, tiempo consumido, qué cupo se agotó
  workspaces/risk-policy.ts Política de riesgo del tenant (read/write/send/money/delete → directo o aprobación); solo endurece
  workspaces/service.ts     Guardar políticas del workspace (riesgo, modelos UE, cupo por defecto) con auditoría
```

Módulos con servicio, rutas y (donde aplica) job: `contacts/`, `conversations/` (inbox), `leads/`, `agenda/`, `sequences/` (`sequence.step`), `routines/` (`routine.cron`). Siguen sin cablear: `templates/` y `knowledge/` (RAG).
