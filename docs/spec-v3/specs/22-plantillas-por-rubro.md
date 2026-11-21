# 22. Plantillas por rubro (F7)

Una plantilla instala un agente de partida (prompt, tools, horarios, una secuencia semilla). No instala el flujo que el negocio va a recorrer: eso lo decide el agente en cada Task.

Base: spec 16 de docs-v2.

### T22.1. Formato
- **Hacer**: `packages/templates/<rubro>/template.json` con versión, preguntas del configurador (zod), agentes (prompt con variables `{{negocio.nombre}}`), tools y aprobaciones, FAQ semilla, secuencias, horarios, etapas del embudo.
- **Hecho cuando**: validador y test de cada plantilla.

### T22.2. Instalación
- **Hacer**: `GET /v1/templates`, `POST /v1/templates/:key/install` (transacción; crea todo y registra `TemplateInstall`); idempotente por `Idempotency-Key`.
- **Hecho cuando**: test que instala y desinstala sin dejar basura.

### T22.3. Plantillas iniciales
- **Hacer**: 3 o 4 rubros (por ejemplo peluquería o estética, consultorio, inmobiliaria, comercio) ⚠ VERIFICAR rubros del piloto con Roberto; usar como inspiración los perfiles prearmados de Tropa (`public/app.js`, `presetCards`).
- **Hecho cuando**: cada una deja un agente de WhatsApp que agenda y carga leads.

### T22.4. Checklist de activación
- **Hacer**: `GET /v1/workspace/checklist`: conexiones faltantes, canal conectado, horario cargado, FAQ mínima.
- **Hecho cuando**: test.
