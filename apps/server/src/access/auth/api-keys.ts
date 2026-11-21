import type { Db } from "../../data/db.js";
import { randomToken, sha256Hex } from "../../shared/security/crypto.js";
import { forbidden, invalid, notFound } from "../../shared/errors.js";
import { audit, type Actor } from "../../data/audit.js";
import { isScope, type Principal, type Scope } from "./scopes.js";

const PREFIX = "ega";

/**
 * API keys. Formato: ega_<prefijo 8>_<secreto>. Se guarda sha256(token) y el prefijo (visible).
 * El token completo solo se devuelve al crearla.
 */
export class ApiKeyService {
  constructor(private readonly db: Db) {}

  async issue(input: { workspaceId: string; name: string; scopes: Scope[]; createdById?: string; expiresAt?: Date }) {
    const prefix = randomToken(6).replace(/[-_]/g, "x").slice(0, 8);
    const token = `${PREFIX}_${prefix}_${randomToken(24)}`;
    const key = await this.db.apiKey.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.name,
        prefix,
        hash: sha256Hex(token),
        scopes: input.scopes,
        createdById: input.createdById ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    });
    return { key, token };
  }

  /** Emisión desde la API: valida scopes e impide escalar privilegios (nadie concede lo que no tiene). */
  async issueFor(principal: Principal, input: { name: string; scopes: string[]; expiresAt?: Date }, actor: Actor) {
    const unknown = input.scopes.filter((s) => !isScope(s));
    if (unknown.length) throw invalid("invalid_scopes", `Scopes inválidos: ${unknown.join(", ")}`);
    const scopes = input.scopes as Scope[];
    const escalation = scopes.filter((s) => !principal.scopes.has(s));
    if (escalation.length) throw forbidden(`No puedes conceder scopes que no tienes: ${escalation.join(", ")}`);
    const issued = await this.issue({
      workspaceId: principal.workspaceId,
      name: input.name,
      scopes,
      createdById: principal.actorId,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });
    await audit(this.db, { workspaceId: principal.workspaceId, actor, action: "api_key.created", target: `api_key:${issued.key.id}`, data: { scopes } });
    return issued;
  }

  list(workspaceId: string) {
    return this.db.apiKey.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
  }

  async revoke(workspaceId: string, id: string, actor: Actor): Promise<void> {
    const res = await this.db.apiKey.updateMany({ where: { id, workspaceId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count === 0) throw notFound("API key");
    await audit(this.db, { workspaceId, actor, action: "api_key.revoked", target: `api_key:${id}` });
  }

  async verify(token: string): Promise<Principal | null> {
    if (!token.startsWith(`${PREFIX}_`)) return null;
    const key = await this.db.apiKey.findUnique({ where: { hash: sha256Hex(token) } });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date())) return null;
    void this.db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return { kind: "api_key", actorId: key.id, workspaceId: key.workspaceId, scopes: new Set(key.scopes as Scope[]) };
  }
}
