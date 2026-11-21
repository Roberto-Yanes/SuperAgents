# 90. Decisiones (ADRs)

Formato corto: contexto, decisión, consecuencias. Estado: aceptada salvo indicación.

Estos ADR son el diseño original. Los de `docs/adr/` son la dirección vigente y ganan si discuten. En particular: el ADR 003 (agente autónomo, no un flujo), el ADR 004 (pg-boss detrás de un puerto; Temporal solo con criterios) y el ADR 005 (LLM solo en la UE). El `user_id` de Composio que de verdad usa el código es `ega:<workspaceId>:integration`, no el `ws_<id>:integration` de este archivo: no lo cambies, las cuentas conectadas dependen de él (`docs/adr/002-composio-una-key.md`).

## ADR-001. Plataforma headless y API-first
- **Contexto**: la UI estilo Grok Bot se hace aparte (desktop, web, móvil) y debe poder cambiar sin tocar el motor.
- **Decisión**: el repo no incluye UI. Todo se expone por REST + WS + SSE con OpenAPI y SDK TS.
- **Consecuencias**: cada función nueva nace con su endpoint y sus eventos; la UI puede empezar en la semana 4.

## ADR-002. Un workspace primero, multitenant como switch
- **Contexto**: el MVP 1 no es SaaS, pero no queremos reescribir después.
- **Decisión**: `workspaceId` en toda entidad, extensión de Prisma que lo exige, auth por sesión o API key que resuelve el workspace. Registro abierto y facturación quedan apagados (`MULTI_TENANT=false`).
- **Consecuencias**: costo mínimo hoy; para SaaS falta registro, planes, cuotas y revisión de aislamiento (spec 30).

## ADR-003. Proceso de larga vida en Docker
- **Contexto**: los agentes deben trabajar 24/7 sin UI abierta.
- **Decisión**: `apps/server` corre con Docker Compose (server, Postgres, Caddy) en VPS, PC o mini PC. Roles `all`, `api`, `worker`.
- **Consecuencias**: disponibilidad depende del host; recomendación comercial: VPS o mini PC dedicada.

## ADR-004. TypeScript, Fastify, Prisma 7, PostgreSQL con pgvector
- **Decisión**: stack de `08-stack-y-repo.md`. Prisma 7.10.x estable (no 8.0-rc).
- **Consecuencias**: Postgres es la única dependencia de infraestructura.

## ADR-005. pg-boss como cola y scheduler
- **Contexto**: hace falta cola durable, reintentos, cron, envíos diferidos y serializar por conversación.
- **Decisión**: pg-boss 12 (grupos con `groupConcurrency`, `singletonKey`, `startAfter`, `deadLetter`, `schedule`). Sigue siendo el adaptador. El dominio tiene que hablarle a un puerto, no a pg-boss. Temporal (self-hosted en Hetzner EU) entra solo con los criterios de `docs/adr/004-motor-jobs-pgboss-temporal.md`.
- **Alternativas**: BullMQ (requiere Redis), SQLite con cola propia (más código). Para un despliegue mínimo sin Postgres no hay soporte en el MVP.
- **Consecuencias**: sin Redis.

## ADR-006. Adaptadores de canal intercambiables (Baileys y Cloud API)
- **Contexto**: hoy WhatsApp funciona con Baileys; la aplicación de Tech Provider está presentada y se espera la decisión de Meta.
- **Decisión**: interfaz `ChannelAdapter` única. `Channel.provider` = `BAILEYS` o `META_CLOUD`. Contactos y conversaciones se indexan por teléfono E.164 normalizado, así que el cambio de proveedor (`/channels/:id/switch-provider`) conserva el historial. Las capacidades (`templates`, `window24h`) se declaran por adaptador y las reglas (ventana, plantillas) se aplican solo si el adaptador las declara.
- **Consecuencias**: el socket de Baileys vive en un único proceso (advisory lock); Cloud API necesita HTTPS público.

## ADR-007. LLM por API key multi-proveedor, más modelos locales
- **Decisión**: Vercel AI SDK, clave del workspace en nuestro vault (no pasa por Composio). La lista abierta de este ADR queda cerrada por `docs/adr/005-llm-residencia-ue.md`: solo proveedores con región UE (Azure OpenAI EU, Mistral, modelo hospedado en la UE, Ollama en el servidor de la UE). Grok y los endpoints públicos sin región se rechazan.
- **Consecuencias**: costos medibles por run (`Run.costUsd` con tabla de precios por modelo en `packages/llm`); no se usan CLI con suscripción personal para atender clientes.

## ADR-008. Caras externa e interna separadas por código
- **Decisión**: el runtime arma listas de tools y contexto distintos según `Conversation.kind`; tools externas atadas al contacto actual.
- **Consecuencias**: la inyección de prompt de un cliente no alcanza tools internas.

## ADR-009. Aprobaciones persistidas y outbox para efectos externos
- **Decisión**: `Approval` en DB con vencimiento; `OutboundSend` con clave de idempotencia antes de cada efecto.
- **Consecuencias**: reanudar nunca duplica mensajes, turnos ni leads.

## ADR-010. Eventos con `seq` y LISTEN/NOTIFY
- **Decisión**: tabla `Event` como log y fuente del WS; NOTIFY para despertar suscriptores; reproducción por `afterSeq`.
- **Consecuencias**: la UI reconecta sin perder eventos; sirve de base para disparadores EVENT.

## ADR-011. Las reglas de negocio viven en código
- **Decisión** (se mantiene de docs-v2): horarios, ventana de 24 h, slots, límites y validaciones las hace el código; el LLM elige tools.

## ADR-012. Reutilización de Tropa v2
- **Decisión**: portar los módulos listados en `08-stack-y-repo.md` (Baileys, partición de mensajes, delegación, flujos, modelos locales, documentos). Tropa es Apache-2.0.
- **Pendiente**: confirmar titularidad del código de Tropa para este producto ⚠ VERIFICAR con Roberto.
- **Nota de licencias**: Baileys arrastra `libsignal` (GPL-3.0) según `docs/WHATSAPP-DEPENDENCIAS.md` de Tropa. En un servidor propio no se distribuye binario; si algún día se distribuye el motor como instalador, revisar.

## ADR-013. Ejecutores enchufables (post-MVP)
- **Decisión**: interfaz `Executor` (`server`, `device`, `sandbox`) en el registro de tools. El runtime local en una PC (protocolo de docs-v2, doc 04, inspirado en el relay de Tropa) y OpenSandbox (ADR-013 de docs-v2) se agregan sin tocar el runtime.
- **Consecuencias**: en el MVP todas las tools corren en el servidor.

## ADR-014. Composio como capa única de conectores
- **Estado**: aceptada (21/11/2026). **Reemplaza** el diseño de conectores nativos por app (clientes propios de Google y Holded, OAuth y vault propios para apps de terceros) de la versión anterior de la spec 16, de las specs 17 y 18, y de las specs 13 y 14 de docs-v2.
- **Contexto**: el negocio quiere conectar "lo que quiera" (Holded, Google Calendar, Gmail, CRMs, planillas). Escribir y mantener un cliente, un OAuth y un refresco de tokens por app no escala, y cada app nueva era una semana de trabajo. Composio ofrece catálogo (1841 toolkits en docs.composio.dev/toolkits al 21/11/2026), auth administrada, ejecución de acciones y triggers por webhook.
- **Decisión**:
  - Toda app de terceros se conecta por Composio. No hay servicios ni conectores por app en nuestro código.
  - `ComposioGateway` (`packages/tools/composio`) vive dentro del registro de tools: lista toolkits, crea Connect Links, registra connected accounts, expone acciones como tools propias (`app.<toolkit>.<acción>`) y recibe triggers.
  - Encima de cada acción van nuestras reglas: scope (cara interna o externa), riesgo, aprobación, outbox y auditoría. El LLM nunca recibe las meta tools de Composio (búsqueda, manejo de conexiones, workbench).
  - `user_id` de Composio = `ws_<workspaceId>:integration` (cuenta del negocio) o `ws_<workspaceId>:user_<userId>` (cuenta personal), como recomienda la guía B2B de Composio. Un proyecto de Composio por entorno (dev, staging, prod).
  - La API key de Composio vive solo en el backend (`COMPOSIO_API_KEY`), nunca llega a la UI ni al modelo.
  - Nuestro vault guarda solo lo que no es de Composio: claves de LLM, SMTP, token de Meta Cloud API, sesión de Baileys.
  - Los canales de mensajería entrante en tiempo real (WhatsApp Baileys y Cloud API) siguen como `ChannelAdapter` nativos. Necesitan webhook o socket propio con respuesta inmediata, reglas de ventana de 24 h y plantillas, takeover humano, orden por conversación e idempotencia por `wamid`. Composio no cubre ese rol.
  - El email puede ir por los dos lados: `SMTP` nativo (cualquier casilla) o `COMPOSIO_EMAIL` (Gmail u Outlook: envío por acción y entrada por el trigger `GMAIL_NEW_GMAIL_MESSAGE`).
  - Lo que el catálogo no cubre se resuelve dentro de Composio, en este orden: (1) Proxy Execute con la misma conexión, (2) toolkit Custom MCP (p. ej. el MCP oficial de Holded), (3) tool local con `experimental_createToolkit`. Solo si nada de eso sirve se escribe un conector nativo, que necesita su propio ADR.
- **Consecuencias**:
  - Agenda y Holded pasan de clientes propios a mapeos finos sobre acciones de Composio. El roadmap baja alrededor de 1 semana, de 14 a 13 (ver `09-roadmap.md`). Además, cualquier app nueva del catálogo pasa a ser configuración, no desarrollo.
  - Desaparecen el OAuth propio con Google, la verificación de la app de Google y el refresco de tokens, mientras se use la app administrada por Composio. Si se quiere la marca propia en la pantalla de consentimiento, se configura un auth config con nuestra app OAuth (white-label) y ahí vuelve la verificación de Google.
  - Dependencia de un tercero. Mitigaciones:
    - Versiones de toolkit fijadas en `AppTool.toolkitVersion`.
    - Errores de Composio clasificados como reintentables.
    - Estado de conexiones espejado en `Connection`.
    - Interfaz `AppGateway` para poder cambiar de proveedor.
  - Residencia de datos: Composio Cloud corre en EE. UU. Los argumentos y resultados de las acciones quedan en sus logs hasta un año, salvo Zero Data Retention (plan pago). Para clientes que exijan datos en la UE, Composio ofrece self-hosting en el plan Enterprise. Se declara en la política de privacidad del producto.
  - Costo: el plan Hobby es gratis y trae 100.000 tool calls por mes (hasta 20.000 sobre apps administradas por Composio), 50.000 triggers y 2.000 req/min. Pro cuesta US$29 por mes más uso, con 10.000 req/min. Alcanza con holgura para el MVP de un solo workspace.

