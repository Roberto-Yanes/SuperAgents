/**
 * Interfaz ChannelAdapter: el proveedor se cambia por canal sin tocar el runtime.
 * - Entrada: el adaptador normaliza lo que llega (socket de Baileys, webhook de Cloud API, IMAP...) y encola channel.inbound.
 * - Salida: el worker de message.outbound llama a send() y guarda el id del canal.
 */
export interface OutboundMessage {
  workspaceId: string;
  conversationId: string;
  externalThreadId: string | null;
  text: string;
  /** Clave estable: el adaptador debe usarla para no duplicar envíos en reintentos. */
  idempotencyKey: string;
}

/** Error temporal (sesión reconectando, 5xx, timeout): el worker reintenta en vez de marcar FAILED. */
/** Error temporal y con la certeza de que el mensaje NO salió (429, 5xx, sesión desconectada…): se reintenta. */
export class RetryableChannelError extends Error {
  readonly retryable = true;
}

/** Se cortó a mitad (timeout, conexión reiniciada tras enviar): el mensaje pudo llegar. No se reintenta solo (H4). */
export class ChannelDeliveryUnknownError extends Error {
  readonly deliveryUnknown = true;
}

export interface SendResult {
  channelMessageId: string;
}

export interface ChannelAdapter {
  /** Valor de Conversation.channel que atiende: "api" | "whatsapp" | "email" | "instagram" */
  readonly channel: string;
  /** Tipo de Connection que usa: "channel.whatsapp_baileys", "channel.whatsapp_cloud", ... (null para "api") */
  readonly connectionKind: string | null;
  send(message: OutboundMessage, connection: { id: string; config: unknown; secret: unknown } | null): Promise<SendResult>;
  /** Restricciones del canal antes de enviar (p. ej. ventana de 24 h de WhatsApp). Lanza si no se puede. */
  assertCanSend?(conversation: { lastInboundAt: Date | null }): void;
}

/**
 * Registro por tipo de conexión: dos proveedores del mismo canal (Baileys y Cloud API para "whatsapp")
 * conviven; la conversación sabe por qué conexión entró y sale por la misma.
 */
export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): this {
    this.adapters.set(adapter.connectionKind ?? "api", adapter);
    return this;
  }

  /** connectionKind null → canal "api". */
  forConnectionKind(kind: string | null): ChannelAdapter | undefined {
    return this.adapters.get(kind ?? "api");
  }
}

/** Canal "api": la respuesta ya llega a la UI por eventos (SSE/WS); no hay envío externo. */
export const apiChannel: ChannelAdapter = {
  channel: "api",
  connectionKind: null,
  async send(message) {
    return { channelMessageId: `api:${message.idempotencyKey}` };
  },
};

/** Ventana de 24 h de WhatsApp: fuera de ella solo plantillas aprobadas. */
export function assertWhatsappWindow(conversation: { lastInboundAt: Date | null }, now = new Date()): void {
  const last = conversation.lastInboundAt?.getTime() ?? 0;
  if (now.getTime() - last > 24 * 3_600_000) {
    throw new Error("Fuera de la ventana de 24 h de WhatsApp: hace falta una plantilla aprobada");
  }
}
