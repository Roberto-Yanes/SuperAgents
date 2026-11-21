import type { Db } from "../../data/db.js";
import { randomToken, sha256Hex } from "../../shared/security/crypto.js";
import type { Principal } from "../auth/scopes.js";

const TICKET_TTL_MS = 60_000;

/**
 * Tickets de un solo uso para abrir el WebSocket o un stream SSE desde el navegador
 * (ni el handshake WS ni EventSource permiten enviar Authorization / X-Workspace-Id).
 */
export class WsTicketService {
  constructor(private readonly db: Db) {}

  async issue(p: Principal): Promise<{ ticket: string; expiresAt: Date }> {
    const ticket = `wst_${randomToken(32)}`;
    const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
    await this.db.wsTicket.create({
      data: { workspaceId: p.workspaceId, hash: sha256Hex(ticket), actorType: p.kind, actorId: p.actorId, scopes: [...p.scopes], expiresAt },
    });
    return { ticket, expiresAt };
  }

  /** Consumo atómico: un solo uso y sin caducar. Devuelve el workspace y los scopes, o null. */
  async consume(ticket: string): Promise<{ workspaceId: string; scopes: string[]; actorType: string; actorId: string } | null> {
    const hash = sha256Hex(ticket);
    const used = await this.db.wsTicket.updateMany({ where: { hash, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (used.count === 0) return null;
    const row = await this.db.wsTicket.findUniqueOrThrow({ where: { hash } });
    return { workspaceId: row.workspaceId, scopes: row.scopes, actorType: row.actorType, actorId: row.actorId };
  }
}
