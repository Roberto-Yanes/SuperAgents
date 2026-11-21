# shared/ — Transversal: seguridad y observabilidad

```
shared/
  config/env.ts            Variables de entorno validadas con zod (falla al arrancar si falta algo)
  security/crypto.ts       AES-256-GCM para secretos (con rotación), sha256, tokens, JSON canónico
  observability/logger.ts  pino con redacción de credenciales
  errors.ts                DomainError (tipo + código estable); la capa de acceso lo traduce a HTTP
```

`shared` no importa nada del resto del proyecto.
