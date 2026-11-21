# ADR 002 — Una sola API key de Composio por servidor

## Decisión

`COMPOSIO_API_KEY` es una por proceso (variable de entorno o secreto de Docker), solo en el backend. La conexión `composio` guarda la lista blanca de acciones y las versiones de toolkit, no una key. Si alguien envía `secret.apiKey`, la alta se rechaza. La migración anula el `secretEnc` de las conexiones `composio` ya guardadas y no toca el resto.

## Por qué

Una key por workspace mezclaba el proyecto de Composio con el tenant y podía quedar en la base cifrada de cada cliente. El aislamiento entre workspaces sigue siendo `composioUserId(workspaceId)` (`ega:<workspaceId>:integration`), construido en el servidor, más las connected accounts. No se cambia el formato del user id: las cuentas ya conectadas dependen de él.

## Si falta la variable

Composio no publica tools. El arranque lo deja en el log, sin imprimir la key, y `/ready` responde `composio: disabled`. El resto del servidor sigue listo.
