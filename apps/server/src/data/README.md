# data/ — Capa 07 · Datos

- `db.ts`: cliente Prisma 7 con el adaptador `@prisma/adapter-pg`.
- `audit.ts`: registro de auditoría (AuditLog). Todas las capas lo usan para dejar constancia de cambios.
- `blob-store.ts`: `LocalBlobStore`, implementación del puerto `BlobStore` en el volumen de datos (escritura atómica, claves `<workspace>/<archivo>` validadas). Guarda bytes ya cifrados.
- `health.ts`: comprobación de la base de datos para `/ready`.
- `generated/prisma/`: cliente generado por `prisma generate`. **No se edita ni se versiona** (está en .gitignore).
- Esquema y migraciones: `apps/server/prisma/`.

Regla: toda entidad de negocio lleva `workspaceId` y toda consulta filtra por él. Pasar a multitenant es un switch, no una reescritura.
