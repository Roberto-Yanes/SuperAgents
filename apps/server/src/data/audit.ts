/** Registro de auditoría (quién hizo qué, sobre qué). Vive en la capa de datos porque persiste en AuditLog. */
import type { Db } from "./db.js";
import type { Prisma } from "./generated/prisma/client.js";

export interface Actor {
  type: "user" | "api_key" | "system";
  id: string | null;
}

export const systemActor: Actor = { type: "system", id: null };

export async function audit(
  db: Pick<Db, "auditLog">,
  e: { workspaceId: string; actor: Actor; action: string; target?: string; data?: Prisma.InputJsonValue; ip?: string },
): Promise<void> {
  await db.auditLog.create({
    data: {
      workspaceId: e.workspaceId,
      actorType: e.actor.type,
      actorId: e.actor.id,
      action: e.action,
      target: e.target ?? null,
      data: e.data ?? {},
      ip: e.ip ?? null,
    },
  });
}
