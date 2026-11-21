# Documentación de everglow-agentes

everglow-agentes es el motor de **Everglow**. Studio es de Galatea: no los acoples. El producto automatiza tareas de un negocio con agentes autónomos. El agente recibe un objetivo, investiga, planifica, usa tools y ejecuta. WhatsApp es un canal, no el producto entero. Los clientes son europeos: los modelos van por BYOK y tienen que procesar en la UE.

Si un documento viejo habla de flujos predefinidos, de “solo WhatsApp” o de un chat “estilo Grok Bot” como si ese fuera el modelo, manda `docs/adr/`. “Estilo Grok Bot” en la spec nombra la forma de un chat. El modelo de xAI no se usa.

## Índice

| Documento                                                                      | Qué es                                                                            |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| [adr/003-runtime-agentes-autonomos.md](adr/003-runtime-agentes-autonomos.md)   | Task, plan, cupos, riesgo, memoria, auditoría, delegación.                        |
| [adr/004-motor-jobs-pgboss-temporal.md](adr/004-motor-jobs-pgboss-temporal.md) | pg-boss detrás de un puerto. Temporal en Hetzner EU solo con criterios medidos.   |
| [adr/005-llm-residencia-ue.md](adr/005-llm-residencia-ue.md)                   | Proveedores y regiones permitidos, validación BYOK, logs y retención.             |
| [adr/001-cola-durante-aprobacion.md](adr/001-cola-durante-aprobacion.md)       | Mensajes que llegan con una decisión pendiente.                                   |
| [adr/002-composio-una-key.md](adr/002-composio-una-key.md)                     | Una sola `COMPOSIO_API_KEY` por servidor.                                         |
| [ROADMAP.md](ROADMAP.md)                                                       | Backlog priorizado, con criterios de aceptación.                                  |
| [DECISIONS.md](DECISIONS.md)                                                   | Registro corto de las decisiones ya tomadas.                                      |
| [ARCHITECTURE.md](ARCHITECTURE.md)                                             | Capas del motor y flujos que ya existen.                                          |
| [OPERATIONS.md](OPERATIONS.md)                                                 | Despliegue, secretos, residencia.                                                 |
| [REVIEW-FIXES.md](REVIEW-FIXES.md)                                             | Qué se corrigió de la revisión de código.                                         |
| [revision-codigo-v2.md](revision-codigo-v2.md)                                 | Foto de la revisión del 21/11/2026. No es el backlog.                             |
| [spec-v3/](spec-v3/README.md)                                                  | Diseño original del motor (paridad de capacidades). Se lee con los ADR de arriba. |

## Cómo leerlo

1. Mirá el ADR 003, el 004 y el 005. Ahí está la dirección.
2. Mirá `ROADMAP.md` si vas a implementar. Cada épica dice cuándo está hecha.
3. Usá `spec-v3/` para el detalle del motor que ya está pensado (canales, outbox, Composio, caras). Si choca con un ADR de `docs/adr/`, gana el ADR.
4. `revision-codigo-v2.md` explica hallazgos de una foto vieja. Varios ya están cerrados en `REVIEW-FIXES.md`.
