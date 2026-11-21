# 30. Post-MVP

## Instagram y Messenger
- Adaptadores `META_IG` y `META_MESSENGER` sobre el mismo webhook de Meta; ventana de 24 h y etiqueta de agente humano de 7 días en Instagram; mensajes de hasta 1000 bytes (datos verificados en docs-v2, spec 23). Referencia: [Instagram Messaging API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api).

## Multitenant
- Activar `MULTI_TENANT=true`: registro, creación de workspace, `X-Workspace-Id`, planes y cuotas, auditoría de aislamiento (tests que recorren todos los repositorios), Row Level Security en Postgres como segunda barrera ⚠ VERIFICAR costo con Prisma.

## Ejecutores enchufables
- Interfaz `Executor` en `packages/executors`: `server` (default), `device` (runtime local en la PC del usuario por WS saliente con tareas firmadas; protocolo de docs-v2 doc 04; ports de Tropa `protocol/crypto.mjs`, `browser-service.mjs`, `site-policy.mjs`, `local-tools.mjs`), `sandbox` (OpenSandbox: navegador y `code.run` aislados; ADR-013 y sección CLOUD_SANDBOX de docs-v2).

## Otros
- Crear agentes y equipos desde el chat (tools `agents.create`, `teams.create`, idea de Tropa).
- Gmail entrante: ya no es futuro; se cubre con el trigger de Composio (spec 19, T19.4b). Queda acá solo si se exige una app OAuth propia, en cuyo caso vuelve la verificación del scope restringido.
- Composio self-hosted (Enterprise) para clientes con requisito de residencia de datos en la UE.
- Toolkit `WHATSAPP` de Composio para tareas administrativas de la WABA (plantillas, perfiles), si conviene más que la Graph API directa.
- Voz y notas de audio (transcripción).
- Webhooks salientes para integraciones.
