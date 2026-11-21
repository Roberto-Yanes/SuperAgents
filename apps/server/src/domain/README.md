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
```

Siguientes módulos (con su tabla, servicio, rutas y job): `leads/` (embudo), `appointments/` (agenda y turnos), `sequences/` (secuencias de seguimiento), `routines/` (cron por agente), `templates/` (plantillas por rubro), `knowledge/` (base de conocimiento).
