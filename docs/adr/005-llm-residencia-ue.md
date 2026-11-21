# ADR 005 — LLM con residencia en la UE

Estado: aceptada (21/11/2026). Precisa el ADR-007 de `docs/spec-v3/90-decisiones.md` y el párrafo de datos personales de `docs/spec-v3/07-seguridad.md`. Si discuten, manda este.

## Contexto

Los clientes de everglow-agentes están en Europa, en particular en España. El producto tiene que poder explicar, por tenant, dónde se procesó cada uso de IA, con qué modelo y con qué supervisión humana. Eso es RGPD (los prompts y los mensajes son datos personales) y la exigencia de poder auditar el uso de IA en una empresa.

El diseño original dejaba la clave del modelo en manos del negocio (BYOK) y aceptaba OpenAI, Anthropic, Google y servidores locales sin preguntar la región. Para este mercado eso no alcanza: una clave válida puede apuntar a un procesamiento fuera de la UE.

Este ADR no es un dictamen jurídico. Es la regla de producto para no mandar datos de clientes a un proveedor que no procesa en la UE.

## Decisión

Cada workspace elige sus modelos (BYOK), y cada conexión tiene que declarar un proveedor y una región de la UE. Si no podés comprobar la región, la conexión no se guarda. La plataforma publica la lista de lo permitido. El tenant puede achicarla. No puede ampliarla con un proveedor de afuera.

La app de Everglow es un cliente aparte de este repo. “Estilo Grok Bot” en la spec vieja nombra la forma de un chat, no el modelo. Grok (xAI) no se usa: no tiene procesamiento en la UE.

Studio (Galatea) no entra en esta decisión. No compartas claves, logs ni un proxy de modelos con ese producto.

## Qué se puede conectar

| Proveedor                   | Cuándo es válido                                                                                                                                                 | Qué tenés que guardar                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Azure OpenAI                | El recurso está en una región UE (por ejemplo Suecia central, Francia central, Alemania oeste central). El host del endpoint tiene que coincidir con esa región. | proveedor, región, endpoint, despliegue      |
| Mistral                     | La Plateforme, con procesamiento en la UE.                                                                                                                       | proveedor, región `eu`, host permitido       |
| Modelo hospedado en la UE   | El negocio indica región UE y el host está en la lista permitida del tenant (un vLLM o similar en su VPC europea, u otro proveedor que documente la región).     | proveedor, región, host                      |
| Modelo en el mismo servidor | Ollama o compatible, si ese servidor está en la UE (el de Hetzner del cliente). Un Ollama en una laptop de fuera no cuenta para datos de clientes.               | proveedor `self-hosted`, región del servidor |

## Qué no se puede conectar

- xAI / Grok, y cualquier host de ese proveedor.
- `api.openai.com`, la API pública de Anthropic y la API pública de Google, salvo que el endpoint sea uno de la UE de la tabla de arriba (Azure, Vertex en región UE, o un acuerdo de región que el host demuestre). Si el host no demuestra la región, se rechaza.
- Un `baseURL` libre “porque el cliente dice que es Europa”. Tiene que estar en la lista de hosts del proveedor o en la lista UE del tenant.
- Modelos locales apuntando a metadata de nube o a link-local. Eso ya lo bloquea `LLM_BASEURL_ALLOWLIST` y el filtro de SSRF. No lo aflojes.

La comprobación corre al guardar la conexión y al armar el cliente del modelo. Las dos. Un cambio de host a una región de afuera tiene que fallar aunque la fila ya existiera.

El rechazo es un error de dominio claro (`region` o `provider`), sin eco de la clave en el log ni en la respuesta.

## Política por tenant

`llmPolicy` del workspace:

- `allowed`: subconjunto de la lista de la plataforma. Default: toda esa lista.
- Cada conexión guarda `provider`, `region` y `baseURL` (sin la clave en claro).
- Una tarea solo usa una conexión que pase la política en ese momento. Si la conexión dejó de ser válida, la tarea pasa a `BLOCKED` con motivo `model_region`, sin llamar al modelo.

No hay un modelo de plataforma escondido para “salir del paso”. Si el tenant no tiene un modelo UE, no hay inferencia.

## Logs y retención

Separá metadatos de contenido.

| Dato                                                  | Dónde                                   | Retención                                                                                                                                     |
| ----------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Proveedor, modelo, región, tokens, costo, id de tarea | Auditoría del ADR 003 y métricas        | La define el tenant. Default de producto: 12 meses. No lleva el prompt.                                                                       |
| Objetivo, mensajes, resultados de tools               | Tablas de la tarea y de la conversación | La define el tenant. Default de producto: mientras la conversación o la tarea existan, y no más de 12 meses si el tenant no eligió otra cosa. |
| Logs de aplicación (pino)                             | stdout                                  | Sin prompts, sin claves, sin ticket de SSE. Rotación corta del operador (días, no meses).                                                     |
| Clave del modelo                                      | Vault, cifrada, con AAD de la conexión  | Hasta que borran la conexión. Nunca en logs ni en la auditoría.                                                                               |

Exportar o borrar un contacto incluye sus mensajes, su memoria y las tareas de canal atadas a él. Una tarea de la app que haya leído ese contacto se anota en la auditoría; el borrado saca las citas a esa persona de las notas del agente o las deja inutilizables, sin reescribir el historial de otras personas.

Composio Cloud procesa en Estados Unidos. Eso ya está dicho en la spec: para un cliente que exija residencia UE hace falta Composio self-hosted o no usar esa app. No lo tapes con este ADR. El Postgres, los backups y, si algún día existe, Temporal, van a un proveedor en la UE (Hetzner es la opción de referencia).

La supervisión humana que ya existe (aprobación, takeover, cupo) es la que se muestra en la auditoría. No agregues un segundo circuito de “compliance” paralelo.

## Consecuencias

- `LLM_BASEURL_ALLOWLIST` sigue siendo necesaria y deja de ser suficiente: suma la región.
- El estimador de costo no cambia de fórmula. Cada tramo tiene que poder decir región, aunque la tarifa sea de referencia.
- Un piloto en España no arranca con datos reales hasta que guardar una conexión fuera de la UE falle en el producto. Hasta entonces, la regla vive en este ADR y en la operación: no cargues esas claves.
