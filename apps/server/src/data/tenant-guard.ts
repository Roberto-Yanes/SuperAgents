import type { Logger } from "pino";
import type { Db } from "./db.js";

/** Modelos con columna workspaceId (aislamiento multi-tenant). */
export const TENANT_MODELS = new Set([
  "Membership",
  "ApiKey",
  "Connection",
  "Agent",
  "Contact",
  "ContactIdentity",
  "Conversation",
  "Message",
  "Run",
  "RunStep",
  "Approval",
  "Memory",
  "Routine",
  "Event",
  "IdempotencyRecord",
  "AuditLog",
  "WsTicket",
  "PipelineStage",
  "Lead",
  "Calendar",
  "Appointment",
  "Sequence",
  "SequenceEnrollment",
  "KnowledgeDocument",
  "KnowledgeChunk",
  "StoredFile",
]);

/** Operaciones de lectura/escritura masiva donde un where sin workspaceId puede cruzar clientes. */
const GUARDED_OPS = new Set(["findMany", "findFirst", "findFirstOrThrow", "updateMany", "deleteMany", "count", "aggregate", "groupBy"]);

export type TenantGuardMode = "error" | "warn" | "off";

export class TenantGuardError extends Error {
  constructor(model: string, operation: string) {
    super(`Consulta ${model}.${operation} sin workspaceId en el where (usa el cliente de sistema si es intencionado)`);
    this.name = "TenantGuardError";
  }
}

/** ¿El where filtra por workspace? (directo, compuesto workspaceId_x o dentro de un AND). */
export function hasWorkspaceFilter(where: unknown): boolean {
  if (!where || typeof where !== "object") return false;
  const w = where as Record<string, unknown>;
  if (w.workspaceId !== undefined && w.workspaceId !== null) return true;
  if (Object.keys(w).some((k) => k.startsWith("workspaceId_"))) return true;
  const and = w.AND;
  if (Array.isArray(and)) return and.some(hasWorkspaceFilter);
  return and ? hasWorkspaceFilter(and) : false;
}

/**
 * Defensa en profundidad (M7): los servicios que atienden peticiones de un workspace usan este cliente.
 * Una consulta masiva a un modelo multi-tenant sin workspaceId falla (error) o se registra (warn).
 * Los procesos de sistema que cruzan workspaces a propósito (barridos, arranque de sesiones, webhooks por
 * id de conexión, bus) usan el cliente sin guarda.
 */
export function withTenantGuard(db: Db, mode: TenantGuardMode, log?: Logger): Db {
  if (mode === "off") return db;
  return db.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (model && TENANT_MODELS.has(model) && GUARDED_OPS.has(operation) && !hasWorkspaceFilter((args as { where?: unknown } | undefined)?.where)) {
            if (mode === "error") throw new TenantGuardError(model, operation);
            log?.warn({ model, operation }, "consulta multi-tenant sin workspaceId");
          }
          return query(args);
        },
      },
    },
  }) as unknown as Db;
}
