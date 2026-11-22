import { createHash } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../../../container.js";
import { canonicalJson, sha256Hex } from "../../../shared/security/crypto.js";
import { HttpError } from "../errors.js";
import type { Prisma } from "../../../data/generated/prisma/client.js";

const TTL_MS = 24 * 3_600_000;
/** Plazo máximo de una petición en curso; pasado, se considera abandonada (el proceso cayó). */
const LOCK_MS = 2 * 60_000;
const HEADER = "idempotency-key";
const METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Rutas fuera del modelo (sin principal de workspace o con su propia deduplicación). */
const EXCLUDED = [/^\/api\/auth\//, /^\/webhooks\//];

declare module "fastify" {
  interface FastifyRequest {
    idempotencyRecordId?: string;
  }
}

/**
 * Idempotency-Key en TODAS las peticiones con efectos de la API (M4), como hook global:
 * - misma clave + mismo cuerpo → se repite la respuesta guardada (sin repetir el efecto);
 * - misma clave + cuerpo distinto → 422;
 * - misma clave mientras la primera sigue en curso → 409 (hasta LOCK_MS; después se libera);
 * - respuestas 5xx, 401 y 403 no se guardan: liberan la clave para poder reintentar.
 */
export type IdempotencyDeps = Pick<AppContext, "db">;

export const idempotencyPlugin = fp<{ deps: IdempotencyDeps }>(async (app, { deps }) => {
  const db = deps.db;

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers[HEADER];
    if (typeof key !== "string" || key.length === 0) return;
    if (!METHODS.has(req.method) || EXCLUDED.some((r) => r.test(req.url)) || !req.principal) return;
    if (key.length > 200) throw new HttpError(400, "idempotency_key_invalid", "Idempotency-Key demasiado larga");
    const workspaceId = req.principal.workspaceId;
    const path = req.routeOptions.url ?? req.url;
    // Cuerpos binarios (subida de archivos): huella de los bytes, no su JSON.
    const bodyKey = Buffer.isBuffer(req.body) ? `bin:${createHash("sha256").update(req.body).digest("hex")}` : canonicalJson(req.body ?? null);
    const requestHash = sha256Hex(`${req.method} ${path} ${bodyKey}`);
    const now = new Date();

    const existing = await db.idempotencyRecord.findUnique({ where: { workspaceId_key: { workspaceId, key } } });
    if (existing && existing.expiresAt > now) {
      if (existing.requestHash !== requestHash) throw new HttpError(422, "idempotency_key_reused", "La Idempotency-Key ya se usó con otra petición");
      if (existing.statusCode !== null) {
        reply.header("idempotent-replayed", "true");
        return reply.code(existing.statusCode).send(existing.responseBody);
      }
      if (existing.lockedUntil && existing.lockedUntil > now)
        throw new HttpError(409, "idempotency_in_progress", "Hay una petición con esta Idempotency-Key en curso");
    }
    // Caducada o abandonada: se borra de forma condicionada (si otra petición la reclamó entre medias, no se toca).
    if (existing) await db.idempotencyRecord.deleteMany({ where: { id: existing.id, statusCode: existing.statusCode, lockedUntil: existing.lockedUntil } });
    try {
      const record = await db.idempotencyRecord.create({
        data: {
          workspaceId,
          key,
          method: req.method,
          path,
          requestHash,
          lockedUntil: new Date(now.getTime() + LOCK_MS),
          expiresAt: new Date(now.getTime() + TTL_MS),
        },
      });
      req.idempotencyRecordId = record.id;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002")
        throw new HttpError(409, "idempotency_in_progress", "Hay una petición con esta Idempotency-Key en curso");
      throw err;
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    const id = req.idempotencyRecordId;
    if (!id) return payload;
    req.idempotencyRecordId = undefined;
    if (reply.statusCode >= 500 || reply.statusCode === 401 || reply.statusCode === 403) {
      await db.idempotencyRecord.delete({ where: { id } }).catch(() => undefined);
      return payload;
    }
    let body: Prisma.InputJsonValue | undefined;
    try {
      body = typeof payload === "string" && payload.length > 0 ? (JSON.parse(payload) as Prisma.InputJsonValue) : undefined;
    } catch {
      body = undefined;
    }
    await db.idempotencyRecord
      .update({ where: { id }, data: { statusCode: reply.statusCode, responseBody: body ?? {}, lockedUntil: null } })
      .catch(() => undefined);
    return payload;
  });
});
