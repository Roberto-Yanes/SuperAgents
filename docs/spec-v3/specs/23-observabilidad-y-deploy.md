# 23. Observabilidad y despliegue (F8)

### T23.1. Logs y auditoría
- **Hacer**: pino con `requestId`, `workspaceId`, `runId`; redacción de secretos; `AuditLog` en las acciones de `docs/07-seguridad.md`; `GET /v1/audit`.
- **Hecho cuando**: test de redacción.

### T23.2. Uso y costos
- **Hacer**: `GET /v1/usage` (tokens y costo por agente y día); corte por `dailyBudgetUsd`.
- **Hecho cuando**: test.

### T23.3. Métricas y salud
- **Hacer**: `/ready` (DB, cola, canales), endpoint de métricas Prometheus opcional (runs, latencia LLM, colas, envíos fallidos) ⚠ VERIFICAR si se quiere Prometheus o basta con logs.
- **Hecho cuando**: compose con healthcheck en verde.

### T23.4. Backups y actualización
- **Hacer**: servicio de backup (`pg_dump` diario rotado y copia del volumen de archivos y sesión de Baileys); guía de restauración probada; migraciones automáticas al arrancar con bloqueo.
- **Hecho cuando**: restaurar en una VM limpia y que los canales vuelvan.

### T23.5. Hardening
- **Hacer**: rate limits, CORS, cabeceras de seguridad, límites de tamaño, usuario no root en la imagen, dependencia fijada de Baileys.
- **Hecho cuando**: checklist revisado.
