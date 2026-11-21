import type { z } from "zod";
import type { Db } from "../../data/db.js";
import type { Prisma } from "../../data/generated/prisma/client.js";
import { decryptJson, encryptJson } from "../../shared/security/crypto.js";
import { assertAllowedBaseUrl } from "../../shared/security/url-policy.js";
import { conflict, invalid, notFound } from "../../shared/errors.js";
import { audit, type Actor } from "../../data/audit.js";
import { CONNECTION_KINDS, isConnectionKind, type ConnectionKind } from "./kinds.js";

type ConnectionRow = Awaited<ReturnType<Db["connection"]["findFirstOrThrow"]>>;

export interface TestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/** Prueba una conexión contra su servicio. Cada tipo registra su tester en el contenedor. */
export type ConnectionTester = (conn: ConnectionRow, secret: unknown) => Promise<TestResult>;

export class ConnectionService {
  constructor(
    private readonly db: Db,
    private readonly keys: Buffer[],
    private readonly testers: Partial<Record<ConnectionKind, ConnectionTester>> = {},
    private readonly opts: { baseUrlAllowlist?: string[] } = {},
  ) {}

  private assertUrls(config: unknown): void {
    const baseURL = (config as { baseURL?: unknown } | null)?.baseURL;
    if (typeof baseURL === "string") assertAllowedBaseUrl(baseURL, this.opts.baseUrlAllowlist);
  }

  list(workspaceId: string) {
    return this.db.connection.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
  }

  /** Solo para entradas sin Principal (webhooks): el workspace sale de la propia conexión. */
  findById(id: string): Promise<ConnectionRow | null> {
    return this.db.connection.findUnique({ where: { id } });
  }

  async get(workspaceId: string, id: string): Promise<ConnectionRow> {
    const conn = await this.db.connection.findFirst({ where: { id, workspaceId } });
    if (!conn) throw notFound("Conexión");
    return conn;
  }

  async create(workspaceId: string, input: { kind: string; name: string; config?: unknown; secret?: unknown }, actor: Actor): Promise<ConnectionRow> {
    if (!isConnectionKind(input.kind)) throw invalid("invalid_kind", `Tipo de conexión desconocido: ${input.kind}`);
    const spec = CONNECTION_KINDS[input.kind];
    const config = parseOrThrow(spec.config, input.config ?? {}, "config");
    const secret = parseOrThrow(spec.secret, input.secret ?? {}, "secret");
    await this.assertAgentInWorkspace(workspaceId, config);
    this.assertUrls(config);
    const exists = await this.db.connection.findFirst({ where: { workspaceId, name: input.name }, select: { id: true } });
    if (exists) throw conflict("connection_name_taken", `Ya existe una conexión llamada "${input.name}"`);

    // El secreto se cifra ligado al id de la fila (AAD), así que se crea primero y se cifra después, en la misma transacción.
    const conn = await this.db.$transaction(async (tx) => {
      const row = await tx.connection.create({
        data: { workspaceId, kind: input.kind, name: input.name, config: config as Prisma.InputJsonValue, status: "PENDING" },
      });
      if (!hasKeys(secret)) return row;
      return tx.connection.update({ where: { id: row.id }, data: { secretEnc: new Uint8Array(encryptJson(secret, this.keys[0]!, secretAad(row.id))) } });
    });
    await audit(this.db, { workspaceId, actor, action: "connection.created", target: `connection:${conn.id}`, data: { kind: input.kind } });
    return conn;
  }

  /** config se valida completa (reemplazo); secret, si llega, reemplaza al anterior. */
  async update(
    workspaceId: string,
    id: string,
    patch: { name?: string; config?: unknown; secret?: unknown; status?: "DISABLED" | "PENDING" },
    actor: Actor,
  ): Promise<ConnectionRow> {
    const conn = await this.get(workspaceId, id);
    const kind = conn.kind as ConnectionKind;
    const spec = CONNECTION_KINDS[kind];
    const config = patch.config !== undefined ? parseOrThrow(spec.config, patch.config, "config") : undefined;
    const secret = patch.secret !== undefined ? parseOrThrow(spec.secret, patch.secret, "secret") : undefined;
    if (config) {
      await this.assertAgentInWorkspace(workspaceId, config);
      this.assertUrls(config);
    }
    const updated = await this.db.connection.update({
      where: { id: conn.id },
      data: {
        name: patch.name,
        config: config as Prisma.InputJsonValue | undefined,
        ...(secret !== undefined ? { secretEnc: hasKeys(secret) ? new Uint8Array(encryptJson(secret, this.keys[0]!, secretAad(conn.id))) : null } : {}),
        // Cambiar credenciales o configuración obliga a volver a probar.
        status: patch.status ?? (config || secret ? "PENDING" : undefined),
        lastError: config || secret ? null : undefined,
      },
    });
    await audit(this.db, {
      workspaceId,
      actor,
      action: "connection.updated",
      target: `connection:${id}`,
      data: { fields: Object.keys(patch).filter((k) => k !== "secret"), secretRotated: secret !== undefined },
    });
    return updated;
  }

  async test(workspaceId: string, id: string, actor: Actor): Promise<TestResult> {
    const conn = await this.get(workspaceId, id);
    if (conn.status === "DISABLED") throw conflict("connection_disabled", "La conexión está desactivada");
    const tester = this.testers[conn.kind as ConnectionKind];
    if (!tester) return { ok: false, message: `No hay prueba disponible para ${conn.kind}` };
    let result: TestResult;
    try {
      result = await tester(conn, this.readSecret(conn));
    } catch (err) {
      result = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    await this.db.connection.update({
      where: { id: conn.id },
      data: { status: result.ok ? "OK" : "ERROR", lastError: result.ok ? null : result.message.slice(0, 500) },
    });
    await audit(this.db, { workspaceId, actor, action: "connection.tested", target: `connection:${id}`, data: { ok: result.ok } });
    return result;
  }

  readSecret<T = Record<string, unknown>>(conn: { id: string; secretEnc: Uint8Array | null }): T {
    return (conn.secretEnc ? decryptJson<T>(conn.secretEnc, this.keys, secretAad(conn.id)) : {}) as T;
  }

  /** Los canales enrutan a un agente: debe ser de este mismo workspace. */
  private async assertAgentInWorkspace(workspaceId: string, config: unknown): Promise<void> {
    const agentId = (config as { agentId?: string }).agentId;
    if (!agentId) return;
    const agent = await this.db.agent.findFirst({ where: { id: agentId, workspaceId }, select: { id: true } });
    if (!agent) throw invalid("invalid_agent", "El agente indicado no existe en este workspace");
  }
}

/** Vista pública: nunca incluye secretos, solo si existen y una pista no sensible. */
export function publicConnection(conn: ConnectionRow, publicUrl: string) {
  const hints: Record<string, string> = {};
  if (conn.kind === "channel.whatsapp_cloud") hints.webhookUrl = `${publicUrl}/webhooks/whatsapp/${conn.id}`;
  return {
    id: conn.id,
    kind: conn.kind,
    name: conn.name,
    config: conn.config,
    hasSecret: conn.secretEnc !== null,
    status: conn.status,
    lastError: conn.lastError,
    hints,
    createdAt: conn.createdAt.toISOString(),
    updatedAt: conn.updatedAt.toISOString(),
  };
}

function parseOrThrow(schema: z.ZodType, value: unknown, field: string): unknown {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw invalid(
      `invalid_${field}`,
      `${field} inválido`,
      r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  return r.data;
}

function hasKeys(v: unknown): boolean {
  return Boolean(v) && typeof v === "object" && Object.keys(v as object).length > 0;
}

/** Contexto autenticado (AAD) del secreto de una conexión. */
export function secretAad(connectionId: string): string {
  return `connection:${connectionId}`;
}

/**
 * Recifra todos los secretos de conexiones con la clave actual (keys[0]) y AAD ligado a su fila.
 * Sirve para rotar SECRET_KEY (con la anterior en SECRET_KEY_OLD) y para migrar secretos v1 sin AAD (L4).
 * Idempotente: se puede relanzar. Usado por la CLI rotate-secrets.
 */
export async function reencryptAllSecrets(db: Db, keys: Buffer[]): Promise<{ total: number; rewritten: number }> {
  const rows = await db.connection.findMany({ where: { secretEnc: { not: null } }, select: { id: true, secretEnc: true } });
  let rewritten = 0;
  for (const row of rows) {
    const plain = decryptJson(row.secretEnc!, keys, secretAad(row.id));
    const next = new Uint8Array(encryptJson(plain, keys[0]!, secretAad(row.id)));
    await db.connection.update({ where: { id: row.id }, data: { secretEnc: next } });
    rewritten += 1;
  }
  return { total: rows.length, rewritten };
}
