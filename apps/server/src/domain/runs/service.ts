import type { Db } from "../../data/db.js";
import type { RunStatus } from "../../data/generated/prisma/enums.js";
import { notFound } from "../../shared/errors.js";

/** Consultas de runs para la API (lectura). El ciclo de vida lo gestiona orchestration/runtime. */
export class RunQueryService {
  constructor(private readonly db: Db) {}

  async get(workspaceId: string, runId: string) {
    const run = await this.db.run.findFirst({ where: { id: runId, workspaceId }, include: { steps: { orderBy: { index: "asc" } } } });
    if (!run) throw notFound("Run");
    return run;
  }

  /** Listado paginado por cursor (id uuid v7 = orden temporal), más recientes primero. */
  async list(workspaceId: string, q: { status?: RunStatus; conversationId?: string; agentId?: string; cursor?: string; limit?: number }) {
    const take = Math.min(q.limit ?? 50, 100);
    const rows = await this.db.run.findMany({
      where: {
        workspaceId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.conversationId ? { conversationId: q.conversationId } : {}),
        ...(q.agentId ? { agentId: q.agentId } : {}),
        ...(q.cursor ? { id: { lt: q.cursor } } : {}),
      },
      orderBy: { id: "desc" },
      take: take + 1,
    });
    return { data: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1]!.id : null };
  }

  async exists(workspaceId: string, runId: string): Promise<boolean> {
    return Boolean(await this.db.run.findFirst({ where: { id: runId, workspaceId }, select: { id: true } }));
  }
}
