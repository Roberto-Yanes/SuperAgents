# 14. Canales y WhatsApp (F2)

Hoy WhatsApp corre con **Baileys**; la aplicación de Tech Provider está presentada y se espera a Meta. Por eso los dos proveedores son adaptadores de la misma interfaz y se cambia por canal.

Los canales son nativos y **no** pasan por Composio (ADR-014): son transporte entrante en tiempo real (socket o webhook firmado con respuesta inmediata, ventana de 24 h, takeover, orden por conversación). El único canal que se apoya en Composio es `COMPOSIO_EMAIL` (spec 19).

## Interfaz

```ts
export interface ChannelAdapter {
  readonly provider: ChannelProvider;            // BAILEYS | META_CLOUD | SMTP | COMPOSIO_EMAIL | META_IG
  readonly capabilities: {
    templates: boolean;        // Cloud API: true; Baileys: false
    window24h: boolean;        // Cloud API: true; Baileys: false
    media: { send: boolean; receive: boolean };
    readReceipts: boolean;
    typing: boolean;
  };
  start(channel: Channel, ctx: AdapterContext): Promise<void>;   // Baileys: abre socket. Cloud: no-op
  stop(channelId: string): Promise<void>;
  status(channelId: string): ChannelStatus;
  send(msg: OutboundMessage): Promise<{ externalId: string }>;  // siempre llamado desde outbox
  markRead?(channelId: string, externalId: string): Promise<void>;
}

export type InboundMessage = {
  channelId: string; externalId: string; from: { phone?: string; jid?: string; lid?: string; email?: string; name?: string };
  text?: string; media?: { kind: 'image' | 'audio' | 'video' | 'document'; url?: string; mime?: string }[];
  kind: 'text' | 'media' | 'reaction' | 'protocol' | 'other'; timestamp: Date; raw: unknown;
};
export type OutboundMessage = {
  channelId: string; to: string; text?: string; template?: { name: string; language: string; components?: unknown[] };
  media?: { kind: string; fileId: string }[]; replyTo?: string; idempotencyKey: string;
};
// AdapterContext.onInbound(msg) y onStatus(update) los provee el framework.
```

### T14.1. Framework de canales
- **Hacer**: `packages/channels/common`: registro de adaptadores, `ChannelManager` (arranca los canales `CONNECTED` al iniciar el worker, advisory lock por canal), `onInbound` que persiste `Message` (unique `externalId`), hace upsert de `Contact` e identidad (teléfono E.164) y encola `channel.inbound`; `splitText` (port de `../tropa-desktop/channels/whatsapp.mjs`); rate limiter por canal.
- **Hecho cuando**: tests con adaptador fake: deduplicación, upsert de contacto, rate limit.

### T14.2. Adaptador Baileys
- **Modo port**: `../tropa-desktop/channels/transport-baileys.mjs`, `channels/whatsapp.mjs`, `channels/whatsapp-service.mjs`.
- **Hacer**: `packages/channels/whatsapp-baileys`: estado de auth persistido cifrado (volumen 0700 o tabla vía vault), vinculación por QR o código (evento WS `channel.qr`), reconexión con backoff, `messageKind`, ignorar grupos, broadcast, reacciones y protocolo; normalizar JID y LID a teléfono E.164 cuando se pueda ⚠ VERIFICAR comportamiento de LID con cuentas reales; `send` con texto y media.
- **Hecho cuando**: tests con transporte fake (port de `test/whatsapp-transport.test.mjs` y `test/whatsapp-channel.test.mjs`); prueba manual con un número de prueba.
- **No hacer**: lógica de "dueño" de Tropa (acá el dueño usa la API o la UI).

### T14.3. Adaptador Cloud API
- **Leer**: spec 12 de docs-v2 (datos verificados), [webhooks de Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint), [guía de plantillas](https://developers.facebook.com/docs/whatsapp/message-templates/guidelines/).
- **Hacer**: `packages/channels/whatsapp-cloud`: `GET /v1/webhooks/meta` (verificación `hub.challenge`), `POST` con `X-Hub-Signature-256`, persistencia del payload crudo antes de procesar, mensajes y estados (deduplicar estados por `id` + `status`); `send` texto y plantilla por Graph API con `META_GRAPH_VERSION` en env; `capabilities.window24h = true`.
- **Hecho cuando**: tests con payloads de ejemplo; firma inválida da 401.

### T14.4. Reglas de ventana y plantillas
- **Hacer**: guard en el envío: si el adaptador declara `window24h` y `now - lastInboundAt > 24 h`, solo plantilla; error `outside_window` para el agente y para la API. Sync de plantillas aprobadas (`GET/POST /v1/channels/:id/templates`).
- **Hecho cuando**: tests para Baileys (sin guard) y Cloud (con guard).

### T14.5. Cambio de proveedor
- **Hacer**: `POST /v1/channels/:id/switch-provider`: detiene el adaptador actual, cambia `provider` y credenciales, arranca el nuevo; contactos y conversaciones se mantienen por teléfono E.164.
- **Hecho cuando**: test: conversación creada con Baileys sigue con Cloud API.

### T14.6. Embedded Signup (cuando Meta apruebe)
- **Leer**: [Embedded Signup como Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider).
- **Hacer**: endpoint que recibe el código del flujo de la UI, lo intercambia por token (App Secret solo en el server), registra el número y suscribe la app al WABA; crea `Channel META_CLOUD`.
- **Hecho cuando**: prueba en la app de Meta en modo desarrollo ⚠ VERIFICAR pasos vigentes al momento de la aprobación.
