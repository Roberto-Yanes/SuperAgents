import type { MemberRole } from "../../data/generated/prisma/enums.js";
import type { Actor } from "../../data/audit.js";

/** Scopes de la API pública. Las API keys llevan un subconjunto; los usuarios los heredan de su rol. */
export const SCOPES = [
  "agents:read",
  "agents:write",
  "chats:read",
  "chats:write",
  "runs:read",
  "approvals:read",
  "approvals:write",
  "connections:read",
  "connections:write",
  "contacts:read",
  "contacts:write",
  "agenda:read",
  "agenda:write",
  "leads:read",
  "leads:write",
  "routines:read",
  "routines:write",
  "sequences:read",
  "sequences:write",
  "events:read",
  "api_keys:write",
] as const;

export type Scope = (typeof SCOPES)[number];

const ALL = new Set<Scope>(SCOPES);
const OPERATOR = new Set<Scope>([
  "agents:read",
  "chats:read",
  "chats:write",
  "runs:read",
  "approvals:read",
  // M5: sin approvals:write. Aprobar acciones con efectos (enviar, borrar, pagar) es cosa de OWNER/ADMIN.
  "contacts:read",
  "contacts:write",
  "agenda:read",
  "agenda:write",
  "leads:read",
  "leads:write",
  "routines:read",
  "sequences:read",
  "events:read",
]);

export function scopesForRole(role: MemberRole): Set<Scope> {
  return role === "OPERATOR" ? new Set(OPERATOR) : new Set(ALL);
}

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

/** Quién hace la petición. workspaceId siempre sale de aquí, nunca del cuerpo ni de la URL. */
export interface Principal {
  kind: "api_key" | "user";
  actorId: string;
  workspaceId: string;
  scopes: Set<Scope>;
  role?: MemberRole;
}

/** Actor de auditoría a partir del Principal de la petición. */
export function actorFrom(p: Principal): Actor {
  return { type: p.kind, id: p.actorId };
}
