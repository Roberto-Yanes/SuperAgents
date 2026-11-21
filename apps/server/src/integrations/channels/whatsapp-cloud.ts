import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ChannelDeliveryUnknownError,
  RetryableChannelError,
  assertWhatsappWindow,
  type ChannelAdapter,
  type OutboundMessage,
  type SendResult,
} from "./adapter.js";
import type { ConnectionTester } from "../../domain/connections/service.js";

/**
 * WhatsApp Business Cloud API (oficial). Producción.
 * Entrada: webhook firmado (X-Hub-Signature-256) → access/http/routes/webhooks.ts → channel.inbound.
 * Salida: POST /{phone-number-id}/messages. Fuera de la ventana de 24 h solo plantillas aprobadas.
 * ⚠ Verificar la versión de Graph API vigente al desplegar (config.graphApiVersion).
 */
type FetchLike = typeof fetch;
const GRAPH = "https://graph.facebook.com";

interface CloudConfig {
  phoneNumberId: string;
  graphApiVersion: string;
}
interface CloudSecret {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
}

export function whatsappCloudAdapter(fetchImpl: FetchLike = fetch): ChannelAdapter {
  return {
    channel: "whatsapp",
    connectionKind: "channel.whatsapp_cloud",
    assertCanSend: (conversation) => assertWhatsappWindow(conversation),
    async send(message: OutboundMessage, connection): Promise<SendResult> {
      if (!connection || !message.externalThreadId) throw new Error("Falta conexión o destinatario de WhatsApp");
      const config = connection.config as CloudConfig;
      const secret = connection.secret as CloudSecret;
      const res = await sendRequest(() =>
        fetchImpl(`${GRAPH}/${config.graphApiVersion}/${config.phoneNumberId}/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: message.externalThreadId,
            type: "text",
            text: { body: message.text },
          }),
          signal: AbortSignal.timeout(15_000),
        }),
      );
      const body = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string } };
      if (res.status >= 500 || res.status === 429) throw new RetryableChannelError(`WhatsApp Cloud API ${res.status}`);
      if (!res.ok || !body.messages?.[0]?.id) throw new Error(`WhatsApp Cloud API ${res.status}: ${body.error?.message ?? "sin id de mensaje"}`);
      return { channelMessageId: body.messages[0].id };
    },
  };
}

/** Firma de Meta: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(appSecret, cuerpo crudo). */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface CloudInbound {
  from: string;
  name?: string;
  wamid: string;
  text: string;
  timestamp: string;
}
export interface CloudStatus {
  wamid: string;
  status: "sent" | "delivered" | "read" | "failed";
}

/** Normaliza el payload del webhook: mensajes entrantes y actualizaciones de estado de los enviados. */
export function parseCloudWebhook(payload: unknown): { messages: CloudInbound[]; statuses: CloudStatus[] } {
  const messages: CloudInbound[] = [];
  const statuses: CloudStatus[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as Array<{ changes?: Array<{ value?: Record<string, unknown> }> }>) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = new Map(((value.contacts as Array<{ wa_id: string; profile?: { name?: string } }>) ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of (value.messages as Array<Record<string, unknown>>) ?? []) {
        const from = String(m.from ?? "");
        const id = String(m.id ?? "");
        if (!from || !id) continue;
        messages.push({ from, name: names.get(from) ?? undefined, wamid: id, text: extractText(m), timestamp: String(m.timestamp ?? "") });
      }
      for (const s of (value.statuses as Array<{ id?: string; status?: string }>) ?? []) {
        if (s.id && (s.status === "sent" || s.status === "delivered" || s.status === "read" || s.status === "failed")) {
          statuses.push({ wamid: s.id, status: s.status });
        }
      }
    }
  }
  return { messages, statuses };
}

function extractText(m: Record<string, unknown>): string {
  const type = m.type as string | undefined;
  if (type === "text") return String((m.text as { body?: string })?.body ?? "");
  if (type === "button") return String((m.button as { text?: string })?.text ?? "");
  if (type === "interactive") {
    const i = m.interactive as { button_reply?: { title?: string }; list_reply?: { title?: string } } | undefined;
    return String(i?.button_reply?.title ?? i?.list_reply?.title ?? "");
  }
  const captions = (m[type ?? ""] as { caption?: string } | undefined)?.caption;
  return `[${type ?? "mensaje"} recibido${captions ? `: ${captions}` : ""}]`;
}

export function whatsappCloudTester(fetchImpl: FetchLike = fetch): ConnectionTester {
  return async (conn, rawSecret) => {
    const config = conn.config as unknown as CloudConfig;
    const secret = rawSecret as CloudSecret;
    const res = await fetchImpl(`${GRAPH}/${config.graphApiVersion}/${config.phoneNumberId}?fields=display_phone_number,verified_name`, {
      headers: { authorization: `Bearer ${secret.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, message: `Meta respondió ${res.status}` };
    const body = (await res.json()) as { display_phone_number?: string; verified_name?: string };
    return { ok: true, message: `Número ${body.display_phone_number ?? ""} (${body.verified_name ?? "sin nombre verificado"})`, details: body };
  };
}

const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

/**
 * Clasifica los fallos de red del envío (H4):
 * - no se llegó a conectar (DNS, conexión rechazada) → RetryableChannelError (seguro reintentar);
 * - timeout o conexión cortada después de enviar → ChannelDeliveryUnknownError (pudo llegar: no se reenvía).
 */
async function sendRequest(call: () => Promise<Response>): Promise<Response> {
  try {
    return await call();
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
    if (code && NOT_SENT_CODES.has(code)) throw new RetryableChannelError(`WhatsApp Cloud API inalcanzable (${code})`);
    throw new ChannelDeliveryUnknownError(`Envío a WhatsApp interrumpido: ${err instanceof Error ? err.message : String(err)}`);
  }
}
