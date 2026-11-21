import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import makeWASocket, { DisconnectReason, isJidGroup, isLidUser, isPnUser, jidNormalizedUser, type WAMessage } from "baileys";
import { useEncryptedFileAuthState } from "./baileys-auth-state.js";
import type { Db } from "../../data/db.js";
import type { EventBus } from "../../execution/events/bus.js";
import { JOBS, type JobQueue } from "../../execution/queue/jobs.js";
import { RetryableChannelError, type ChannelAdapter, type OutboundMessage, type SendResult } from "./adapter.js";
import type { ConnectionTester } from "../../domain/connections/service.js";

/**
 * WhatsApp por Baileys (sesión de WhatsApp Web vinculada por QR). SOLO PILOTOS: no es un alta oficial
 * de WhatsApp Business y el número puede ser bloqueado (docs/DECISIONS.md D-010).
 *
 * - La sesión se guarda CIFRADA en disco (volumen "files"): <dataDir>/<connectionId>/*.enc (baileys-auth-state.ts).
 * - Un único proceso worker debe ser dueño de las sesiones (ROLE=all o un único ROLE=worker).
 * - El QR se publica en el bus (subject "connection:<id>", evento channel.qr) para mostrarlo en la UI.
 */

/** Lo mínimo que usamos del socket de Baileys (permite simularlo en tests). */
export interface BaileysSocketLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- la firma de eventos de Baileys es genérica
  ev: { on(event: string, listener: (...args: any[]) => void): unknown };
  sendMessage(jid: string, content: { text: string }): Promise<{ key?: { id?: string | null } } | undefined>;
  end(error?: Error): void;
  logout(): Promise<void>;
}
export type BaileysSocketFactory = (
  authDir: string,
  log: Logger,
  session: { connectionId: string; keys: Buffer[] },
) => Promise<{ socket: BaileysSocketLike; saveCreds: () => Promise<void> }>;

/** Socket real con la sesión cifrada en disco (M10). */
export const defaultBaileysFactory: BaileysSocketFactory = async (authDir, log, session) => {
  const { state, saveCreds } = await useEncryptedFileAuthState(authDir, session);
  const socket = makeWASocket({ auth: state, logger: log.child({ lib: "baileys" }) as never, printQRInTerminal: false, markOnlineOnConnect: false });
  return { socket: socket as unknown as BaileysSocketLike, saveCreds };
};

interface Session {
  socket: BaileysSocketLike;
  open: boolean;
  stopping: boolean;
}

export class BaileysSessionManager {
  private readonly sessions = new Map<string, Session>();
  /** Reintentos por conexión, fuera de la sesión: la sesión se borra al cerrarse y el backoff debe sobrevivir (M2). */
  private readonly retries = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly d: { db: Db; bus: EventBus; queue: JobQueue; log: Logger; dataDir: string; keys?: Buffer[]; factory?: BaileysSocketFactory }) {}

  isOpen(connectionId: string): boolean {
    return this.sessions.get(connectionId)?.open ?? false;
  }

  /** Arranca todas las sesiones no desactivadas (al iniciar el worker). */
  async startAll(): Promise<void> {
    const conns = await this.d.db.connection.findMany({ where: { kind: "channel.whatsapp_baileys", status: { not: "DISABLED" } } });
    for (const c of conns) await this.start(c.id).catch((err) => this.d.log.error({ err, connectionId: c.id }, "no se pudo iniciar la sesión de WhatsApp"));
  }

  async start(connectionId: string): Promise<void> {
    if (this.sessions.has(connectionId)) return;
    const conn = await this.d.db.connection.findFirst({ where: { id: connectionId, kind: "channel.whatsapp_baileys" } });
    if (!conn || conn.status === "DISABLED") return;
    const authDir = this.authDir(connectionId);
    await mkdir(authDir, { recursive: true });
    const log = this.d.log.child({ connectionId });
    const { socket, saveCreds } = await (this.d.factory ?? defaultBaileysFactory)(authDir, log, { connectionId, keys: this.d.keys ?? [] });
    const session: Session = { socket, open: false, stopping: false };
    this.sessions.set(connectionId, session);

    /** Los listeners de Baileys no esperan promesas: cualquier rechazo se captura aquí, nunca escapa (M2). */
    const safe =
      <A extends unknown[]>(name: string, fn: (...args: A) => Promise<void>) =>
      (...args: A) => {
        fn(...args).catch((err: unknown) => log.error({ err, listener: name }, "listener de Baileys falló"));
      };

    socket.ev.on("creds.update", safe("creds.update", () => saveCreds()) as never);
    socket.ev.on(
      "connection.update",
      safe("connection.update", async (u: { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } } }) => {
        if (u.qr) {
          await this.d.db.connection.update({ where: { id: connectionId }, data: { status: "PENDING", lastError: "Escanea el QR para vincular" } });
          await this.d.bus.publish({ workspaceId: conn.workspaceId, type: "channel.qr", subject: `connection:${connectionId}`, data: { qr: u.qr } });
        }
        if (u.connection === "open") {
          session.open = true;
          this.retries.delete(connectionId);
          await this.d.db.connection.update({ where: { id: connectionId }, data: { status: "OK", lastError: null } });
          await this.d.bus.publish({ workspaceId: conn.workspaceId, type: "channel.connected", subject: `connection:${connectionId}`, data: {} });
        }
        if (u.connection === "close") {
          session.open = false;
          this.sessions.delete(connectionId);
          const code = u.lastDisconnect?.error?.output?.statusCode;
          if (session.stopping) return;
          if (code === DisconnectReason.loggedOut) {
            await rm(authDir, { recursive: true, force: true });
            await this.d.db.connection.update({
              where: { id: connectionId },
              data: { status: "ERROR", lastError: "Sesión cerrada desde el teléfono: vuelve a vincular" },
            });
            await this.d.bus.publish({ workspaceId: conn.workspaceId, type: "channel.logged_out", subject: `connection:${connectionId}`, data: {} });
            return;
          }
          this.scheduleReconnect(connectionId, log, code);
        }
      }) as never,
    );
    socket.ev.on(
      "messages.upsert",
      safe("messages.upsert", async ({ messages, type }: { messages: WAMessage[]; type: string }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
          const inbound = normalizeBaileysMessage(msg);
          if (!inbound) continue;
          await this.d.queue.send(JOBS.channelInbound, {
            workspaceId: conn.workspaceId,
            connectionId,
            channel: "whatsapp",
            externalThreadId: inbound.jid,
            channelMessageId: inbound.id,
            from: { id: inbound.contactId, ...(inbound.phone ? { phone: inbound.phone } : {}), ...(inbound.name ? { name: inbound.name } : {}) },
            text: inbound.text,
            receivedAt: new Date().toISOString(),
          });
        }
      }) as never,
    );
  }

  /** Backoff exponencial 1 s → 60 s; si el start falla, se vuelve a programar (antes se quedaba sin reintentar). */
  private scheduleReconnect(connectionId: string, log: Logger, code?: number): void {
    const attempt = this.retries.get(connectionId) ?? 0;
    this.retries.set(connectionId, attempt + 1);
    const delay = Math.min(60_000, 1_000 * 2 ** attempt);
    log.warn({ code, delay, attempt }, "sesión de WhatsApp cerrada, reconectando");
    clearTimeout(this.reconnectTimers.get(connectionId));
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(connectionId);
      if (this.sessions.has(connectionId)) return;
      this.start(connectionId).catch((err: unknown) => {
        log.error({ err }, "reconexión fallida");
        this.sessions.delete(connectionId);
        this.scheduleReconnect(connectionId, log);
      });
    }, delay);
    timer.unref();
    this.reconnectTimers.set(connectionId, timer);
  }

  /** Para tests/diagnóstico. */
  retryCount(connectionId: string): number {
    return this.retries.get(connectionId) ?? 0;
  }

  async stop(connectionId: string, opts: { logout?: boolean } = {}): Promise<void> {
    clearTimeout(this.reconnectTimers.get(connectionId));
    this.reconnectTimers.delete(connectionId);
    this.retries.delete(connectionId);
    const session = this.sessions.get(connectionId);
    if (session) {
      session.stopping = true;
      if (opts.logout) await session.socket.logout().catch(() => undefined);
      session.socket.end();
      this.sessions.delete(connectionId);
    }
    if (opts.logout) await rm(this.authDir(connectionId), { recursive: true, force: true });
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.stop(id);
  }

  async send(connectionId: string, jid: string, text: string): Promise<string> {
    const session = this.sessions.get(connectionId);
    if (!session?.open) throw new RetryableChannelError("La sesión de WhatsApp no está conectada");
    const sent = await session.socket.sendMessage(jid, { text });
    const id = sent?.key?.id;
    if (!id) throw new Error("WhatsApp no devolvió id de mensaje");
    return id;
  }

  private authDir(connectionId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(connectionId)) throw new Error("connectionId inválido");
    return path.join(this.d.dataDir, connectionId);
  }
}

/** Mensaje de Baileys → entrante normalizado. Ignora propios, grupos, estados y mensajes sin texto. */
/**
 * Normaliza un mensaje entrante. Con el direccionamiento LID de WhatsApp el remoteJid puede ser "<id>@lid"
 * (no es un teléfono): el número real viene en key.remoteJidAlt cuando WhatsApp lo comparte (L9).
 * - phone: E.164 sin "+" si se conoce; si no, null (no se inventa un teléfono a partir del LID).
 * - contactId: identificador estable para agrupar el contacto ("<telefono>" o "lid:<id>").
 */
export function normalizeBaileysMessage(
  msg: WAMessage,
): { jid: string; phone: string | null; contactId: string; id: string; name?: string; text: string } | null {
  const remote = msg.key?.remoteJid;
  if (!remote || msg.key?.fromMe || !msg.key?.id) return null;
  if (isJidGroup(remote) || remote === "status@broadcast") return null;
  const m = msg.message;
  const text = m?.conversation ?? m?.extendedTextMessage?.text ?? m?.imageMessage?.caption ?? m?.videoMessage?.caption ?? null;
  if (!text) return null;
  const jid = jidNormalizedUser(remote);
  const alt = (msg.key as { remoteJidAlt?: string }).remoteJidAlt;
  const pnJid = isPnUser(jid) ? jid : alt && isPnUser(alt) ? jidNormalizedUser(alt) : null;
  const phone = pnJid ? pnJid.split("@")[0]!.split(":")[0]! : null;
  const contactId = phone ?? (isLidUser(jid) ? `lid:${jid.split("@")[0]}` : jid);
  return { jid, phone, contactId, id: msg.key.id, ...(msg.pushName ? { name: msg.pushName } : {}), text };
}

export function whatsappBaileysAdapter(manager: BaileysSessionManager): ChannelAdapter {
  return {
    channel: "whatsapp",
    connectionKind: "channel.whatsapp_baileys",
    async send(message: OutboundMessage, connection): Promise<SendResult> {
      if (!connection || !message.externalThreadId) throw new Error("Falta conexión o destinatario de WhatsApp");
      return { channelMessageId: await manager.send(connection.id, message.externalThreadId, message.text) };
    },
  };
}

export function whatsappBaileysTester(): ConnectionTester {
  return async (conn) =>
    conn.status === "OK"
      ? { ok: true, message: "Sesión de WhatsApp vinculada" }
      : { ok: false, message: conn.lastError ?? "Sesión no vinculada: inicia la sesión y escanea el QR" };
}
