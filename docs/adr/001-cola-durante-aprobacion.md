# ADR 001 — Cola de mensajes mientras una decisión está pendiente

## Decisión

Si una conversación tiene un run en `WAITING_APPROVAL`, `QUEUED` o `RUNNING`, un mensaje nuevo (API o canal) se guarda y no abre otro run ni llama al modelo. Cuando ese run termina —aprobado, rechazado, caducado, cancelado o dado por perdido por el barrido— y no queda otro run activo, los entrantes que nadie reclamó se contestan en un solo run.

## Por qué

Dos mensajes seguidos no pueden producir dos respuestas, ni el agente contestarse a sí mismo. Los mensajes que llegan durante la espera no pueden quedarse huérfanos si la decisión se rechaza o caduca.

## Cómo

`ConversationService.receive` es el único punto de entrada. `releaseQueued` abre como mucho un run, con el mismo advisory lock por conversación que `claim`. El runtime, al arrancar un run de mensajes por primera vez, cancela con «sin mensajes nuevos» si no hay ningún entrante sin reclamar y el último mensaje ya es saliente. Una recuperación con el checkpoint vacío no usa esa regla: vuelve a ejecutar y las tools ya hechas se deduplican.
