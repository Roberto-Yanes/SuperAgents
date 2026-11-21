import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import type { Db } from "../../data/db.js";
import type { Auth } from "./better-auth.js";
import type { ApiKeyService } from "./api-keys.js";
import { scopesForRole, type Principal } from "./scopes.js";

/**
 * Resuelve quién llama a partir de las cabeceras:
 * 1. Authorization: Bearer ega_...  → API key con scopes (integraciones, scripts).
 * 2. Cookie de sesión de Better Auth + X-Workspace-Id → usuario con los scopes de su rol (UI).
 */
export class PrincipalResolver {
  constructor(private readonly d: { db: Db; auth: Auth; apiKeys: ApiKeyService }) {}

  async resolve(headers: IncomingHttpHeaders): Promise<Principal | null> {
    const authorization = headers.authorization;
    if (authorization?.startsWith("Bearer ")) return this.d.apiKeys.verify(authorization.slice(7).trim());
    if (!headers.cookie) return null;

    const session = await this.d.auth.api.getSession({ headers: fromNodeHeaders(headers) }).catch(() => null);
    const workspaceId = headers["x-workspace-id"];
    if (!session || typeof workspaceId !== "string") return null;
    const membership = await this.d.db.membership.findFirst({ where: { userId: session.user.id, workspaceId } });
    if (!membership) return null;
    return { kind: "user", actorId: session.user.id, workspaceId, role: membership.role, scopes: scopesForRole(membership.role) };
  }
}
