# Decisiones de arquitectura

Registro breve. Cada entrada: decisión, motivo y consecuencias. Las marcadas ⚑ necesitan confirmación de Rober.

## D-001. Stack del diagrama v3

TypeScript, Fastify 5, Prisma 7, PostgreSQL 16 + pgvector, pg-boss 12, Vercel AI SDK 7, Better Auth, zod 4, Composio y Baileys / Cloud API. Sustituye a la propuesta anterior en Python (docs v1.1), que queda archivada.

## D-002. Versiones fijadas (21/11/2026)

- `prisma` y `@prisma/client` **7.10.1** exactas. En npm, la etiqueta `latest` de `prisma` apunta ya a una 8.0 en _release candidate_; no se actualiza sin probar.
- `typescript` **5.9**. La 7.x (compilador nativo) es la `latest`, pero se aplaza hasta que el ecosistema (tipos de Fastify, Prisma, AI SDK) esté probado con ella.
- `ai` 7.x, `pg-boss` 12.x, `fastify` 5.x, `better-auth` 1.7.x, `zod` 4.x.

## D-003. Monolito modular por capas, un proceso con `ROLE`

Un servidor (`apps/server`) con carpetas por capa del diagrama. `ROLE=all` en el MVP; `api` y `worker` separables sin cambiar código cuando haga falta escalar.

## D-004. Raíz de composición única (`container.ts`)

Las dependencias se construyen en un solo sitio y se inyectan. Los tests sustituyen el LLM (modelo simulado del AI SDK) y la cola sin mocks globales.

## D-005. Aprobaciones con tools sin `execute`

Las tools que requieren aprobación se entregan al modelo sin `execute`. Comprobado con AI SDK 7: el bucle se detiene, las tools automáticas del mismo paso sí se ejecutan y la llamada pendiente queda en el historial. Permite pausar y reanudar (`run.resume`) sin hilos colgados ni volver a pedir la decisión al modelo.

## D-006. Semántica de NEVER / ASK_OWNER / ALWAYS ⚑

Interpretación implementada (el diagrama no la detalla):

- `NEVER`: nunca pide aprobación.
- `ASK_OWNER`: pide aprobación al dueño; el agente puede relajarla a `NEVER` cuando el dueño confíe (override en `toolConfig.approvals`).
- `ALWAYS`: pide aprobación siempre; ningún override la relaja.
  Un override siempre puede endurecer. Confirmar que coincide con lo esperado.

## D-007. Bus de eventos en Postgres

Tabla `Event` con `seq` global (bigserial) y trigger `NOTIFY ega_events` con payload mínimo; el oyente lee la fila completa. Evita Redis en el MVP y da reconexión con `Last-Event-ID`. Los deltas de texto se agrupan (120 ms o 200 caracteres) para no escribir un evento por token.

## D-008. Better Auth solo para sesiones; API keys propias

Las sesiones de la UI usan Better Auth (email y contraseña, Prisma). Las API keys son propias (`ega_<prefijo>_<secreto>`, sha256, scopes) para controlar el formato, los scopes por workspace y la regla «nadie emite una key con más permisos que los suyos». Los workspaces y miembros son tablas propias, no el plugin de organizaciones.

## D-009. Tests sin borrar bases

Los tests aplican migraciones con `prisma migrate deploy` y limpian con TRUNCATE, solo contra bases `*_test` (salvaguarda en código). Prisma 7 bloquea `migrate reset` cuando lo ejecuta un agente de IA sin consentimiento explícito, y es mejor no depender de operaciones destructivas.

## D-010. Riesgo de WhatsApp por Baileys ⚑

El diagrama prevé Baileys hoy y Cloud API al aprobar Tech Provider. Baileys usa una sesión de WhatsApp Web (QR): no es un alta oficial de WhatsApp Business, puede provocar bloqueos del número y no da garantías ante cambios de Meta. Recomendación: usar Baileys solo en pilotos con consentimiento informado del cliente y priorizar Cloud API para producción. La interfaz `ChannelAdapter` permite cambiar de proveedor por canal sin tocar el runtime.

## D-011. pgvector instalado, RAG aplazado

La extensión se crea en el contenedor (`docker/initdb`). Las tablas con embeddings llegan con el módulo de memoria y RAG para no atar el esquema base a un tamaño de vector antes de elegir el modelo de embeddings.

## D-012. SOLID y reglas comprobadas automáticamente

Revisión del 21/11/2026 tras la pregunta de Rober:

- **S:** `AgentRuntime` se divide en `RunStore` (ciclo de vida y checkpoint), `ToolBinder` (tools ↔ AI SDK), `ApprovalGate` (pausar y ejecutar lo aprobado) y `ReplyDelivery` (outbox). El runtime solo orquesta.
- **O:** canales (`ChannelAdapter` por tipo de conexión), tools (`ToolDef` + `ToolProvider` por workspace) y tipos de conexión (catálogo + testers) se amplían registrando piezas, sin tocar el runtime.
- **L / I:** interfaces pequeñas (`JobQueue`, `LlmResolver`, `ToolCatalog`, `ChannelAdapter`, `ComposioClient`, `BaileysSocketLike`). Cada ruta y cada worker declara sus dependencias con `Pick<AppContext, ...>`: recibe solo lo que usa.
- **D:** raíz de composición única (`container.ts`); el dominio define puertos (`ToolNameChecker`, `ConnectionTester`) que implementan otras capas.
- **Rutas finas:** ninguna ruta usa Prisma; delegan en servicios.
- **Comprobación automática:** dependency-cruiser (reglas de capas, Fastify solo en acceso, AI SDK solo en orquestación, sin ciclos), ESLint con reglas de promesas y `import type`, Prettier y CI. En su primera ejecución detectó dos dependencias indebidas y una ruta que faltaba.

## D-013. Sin capa de repositorios sobre Prisma (consciente)

Los servicios usan el cliente Prisma directamente. Prisma ya es un mapeador tipado y los tests corren contra Postgres real, así que una capa de repositorios duplicaría firmas sin aportar aislamiento útil. Se revisará si hace falta otra base de datos o lógica de consulta compleja compartida.

## D-014. Errores de dominio sin HTTP

El dominio lanza `DomainError` (tipo `invalid | unauthorized | forbidden | not_found | conflict` + código estable). Solo `access/http/errors.ts` conoce códigos HTTP. Los errores del protocolo (Idempotency-Key) son `HttpError` y viven en acceso.

## D-015. Orden de entrega del bus de eventos

Las notificaciones de `LISTEN/NOTIFY` se procesan en cadena (una tras otra). Procesarlas en paralelo permitía que `run.finished` adelantase a `message.completed` y que el cursor descartase eventos (fallo intermitente detectado por el test e2e). Test de regresión en `test/ws.test.ts`.

## D-016. Conversación ligada a su conexión

`Conversation.connectionId` registra por qué conexión entró la conversación; la respuesta sale por la misma. Permite tener Baileys y Cloud API (ambos canal `whatsapp`) en el mismo workspace.

## D-017. Revisión de código del 21/11/2026: criterios aplicados

Todas las correcciones de la revisión externa (C1, H1–H6, M1–M12, L1–L10) están en `docs/REVIEW-FIXES.md`, cada una con su test de regresión. Los criterios que quedan como norma del proyecto:

1. **Nunca un `await` sin capturar en un listener** (WebSocket, Baileys, EventEmitter): el handler entero va en `try/catch` y `main.ts` registra `unhandledRejection` sin tumbar el proceso.
2. **Validar UUID antes de consultar columnas uuid** (`shared/validation.ts`).
3. **Un run a la vez por conversación**: cola `run.process` con grupo pg-boss = conversación (`groupConcurrency: 1`, coordinado en base de datos) y, como segunda barrera, `claim` con advisory lock por conversación.
4. **Sin `singletonKey`**: en colas standard de pg-boss no deduplica. La idempotencia vive en el consumidor (transiciones condicionadas y claves únicas).
5. **Toda acción con efectos se "toma" antes de ejecutarse** (`APPROVED→EXECUTING`, `QUEUED→SENDING`, huella `dedupeKey` en RunStep). Si el proceso cae a mitad, el estado pasa a `UNKNOWN` y lo revisa una persona: nunca se repite sola.
6. **Dos caras**: las tools son internas por defecto; en conversaciones con contactos solo se ofrecen las marcadas como externas o las que el dueño expone (con suelo `ASK_OWNER` si escriben). El texto del contacto va envuelto en `<mensaje_del_contacto>`.
7. **Lo que identifica a un cliente lo construye el servidor** (entidad de Composio, workspaceId) y los secretos se cifran ligados a su fila (AAD).

## D-018. Mensajes que llegan mientras un run espera aprobación

Decisión de producto del 21/11 (segunda pasada), que sustituye la anterior (crear un run nuevo en cuanto el contacto escribía). El mensaje se guarda y no se llama al modelo hasta que la decisión se aprueba, se rechaza o caduca. Después se reanuda el run en espera y los mensajes acumulados se contestan en un solo run. Detalle en `docs/adr/001-cola-durante-aprobacion.md`.

## D-019. Guarda multi-tenant en Prisma

Los servicios que atienden a un workspace (conversaciones, contactos, agentes, conexiones, API keys, consulta de runs, agenda, leads, rutinas, secuencias, runtime, tools, aprobaciones por workspace, RunStore y RunControl) reciben un cliente Prisma con una extensión que rechaza consultas masivas (`findMany`, `updateMany`, `count`…) sin `workspaceId` sobre modelos multi-tenant. Los procesos de sistema que cruzan workspaces a propósito (barrido de runs, caducidad de aprobaciones, tick de rutinas, arranque de sesiones, bus, webhooks por id de conexión, recifrado de secretos) usan el cliente sin guarda. Modo `error` en desarrollo y tests, `warn` en producción.

## D-020. Una sola API key de Composio por servidor

`COMPOSIO_API_KEY` es del proceso, no de la conexión ni del workspace. Si falta, Composio queda deshabilitado. Detalle en `docs/adr/002-composio-una-key.md`.

## D-021. El producto es un agente autónomo, no un flujo

everglow-agentes (Everglow, separado de Studio/Galatea) recibe un objetivo, investiga, planifica, usa tools y ejecuta. WhatsApp es un canal. Las secuencias y las plantillas son atajos, no el producto. La unidad de trabajo es una Task. Detalle en `docs/adr/003-runtime-agentes-autonomos.md`.

## D-022. pg-boss detrás de un puerto

No se cambia a Temporal hasta que se mida uno de los criterios del `docs/adr/004-motor-jobs-pgboss-temporal.md` (tareas largas que no se pueden reconstruir, reintentos sin historia, Postgres cargado por la cola). Si se migra: activity = loop, workflow = estado y checkpoints, hospedaje en Hetzner EU.

## D-023. LLM solo con región UE

BYOK, pero el proveedor y la región se validan al guardar y al usar. Azure OpenAI EU, Mistral EU, modelos hospedados en la UE o el servidor propio en la UE. Grok y los endpoints públicos sin región UE se rechazan. “Estilo Grok Bot” en la spec nombra un chat, no ese modelo. Detalle en `docs/adr/005-llm-residencia-ue.md`.
