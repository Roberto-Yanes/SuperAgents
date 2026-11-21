# 21. Memoria y base de conocimiento (F7)

Son tres capas, no un solo balde: RAG del negocio, memoria del contacto y notas del agente. El contrato está en `docs/adr/003-runtime-agentes-autonomos.md`. El modelo de embeddings tiene que cumplir `docs/adr/005-llm-residencia-ue.md`.

### T21.1. Ingesta
- **Hacer**: `/v1/knowledge` (texto, FAQ en pares pregunta-respuesta, archivos PDF, DOCX y TXT); chunking por tamaño con solapamiento; embeddings vía `packages/llm` (modelo configurable ⚠ VERIFICAR dimensión = 1536 o migrar la columna); job `knowledge.ingest`.
- **Hecho cuando**: test con embeddings fake.

### T21.2. kb.search
- **Hacer**: búsqueda híbrida (vector HNSW + texto con `tsvector` en español) limitada a las fuentes del agente; devuelve fragmentos con fuente.
- **Hecho cuando**: test de relevancia básica.

### T21.3. Memoria
- **Hacer**: tools `memory.remember` (interna o sobre el contacto actual) y `memory.recall`; resumen al cerrar conversación largo que guarda hechos del contacto; `/v1/memories` para ver y borrar.
- **Hecho cuando**: tests; un agente externo solo recuerda del contacto actual.
