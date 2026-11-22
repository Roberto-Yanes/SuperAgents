import type { Db } from "../../data/db.js";
import { invalid } from "../../shared/errors.js";

export type UsageGroup = "day" | "agent" | "model";

export interface UsageRow {
  key: string;
  label: string | null;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageReport {
  from: string;
  to: string;
  groupBy: UsageGroup;
  totals: Omit<UsageRow, "key" | "label">;
  rows: UsageRow[];
}

const MAX_RANGE_DAYS = 366;

/**
 * Consumo agregado de LLM del workspace (E3): runs, tokens y coste estimado por día, agente o modelo.
 * El coste es la estimación con la tarifa de cada conexión (o la de referencia), no la factura del proveedor.
 */
export class UsageService {
  constructor(private readonly db: Db) {}

  async report(workspaceId: string, q: { from?: Date; to?: Date; groupBy?: UsageGroup }): Promise<UsageReport> {
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw invalid("invalid_range", "from debe ser anterior a to");
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) throw invalid("invalid_range", `El rango máximo es de ${MAX_RANGE_DAYS} días`);
    const groupBy = q.groupBy ?? "day";

    type Raw = { key: string | null; runs: bigint; input: number | null; output: number | null; cost: string | null };
    const rows =
      groupBy === "day"
        ? await this.db.$queryRaw<Raw[]>`
            SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS key, count(*) AS runs,
                   sum(COALESCE(("usage"->>'inputTokens')::float8, 0)) AS input, sum(COALESCE(("usage"->>'outputTokens')::float8, 0)) AS output,
                   sum("costUsd")::text AS cost
            FROM run WHERE "workspaceId" = ${workspaceId}::uuid AND "createdAt" >= ${from} AND "createdAt" < ${to}
            GROUP BY 1 ORDER BY 1`
        : groupBy === "agent"
          ? await this.db.$queryRaw<Raw[]>`
            SELECT "agentId"::text AS key, count(*) AS runs,
                   sum(COALESCE(("usage"->>'inputTokens')::float8, 0)) AS input, sum(COALESCE(("usage"->>'outputTokens')::float8, 0)) AS output,
                   sum("costUsd")::text AS cost
            FROM run WHERE "workspaceId" = ${workspaceId}::uuid AND "createdAt" >= ${from} AND "createdAt" < ${to}
            GROUP BY 1 ORDER BY sum("costUsd") DESC`
          : await this.db.$queryRaw<Raw[]>`
            SELECT COALESCE("model", 'desconocido') AS key, count(*) AS runs,
                   sum(COALESCE(("usage"->>'inputTokens')::float8, 0)) AS input, sum(COALESCE(("usage"->>'outputTokens')::float8, 0)) AS output,
                   sum("costUsd")::text AS cost
            FROM run WHERE "workspaceId" = ${workspaceId}::uuid AND "createdAt" >= ${from} AND "createdAt" < ${to}
            GROUP BY 1 ORDER BY sum("costUsd") DESC`;

    const labels = new Map<string, string>();
    if (groupBy === "agent" && rows.length > 0) {
      const agents = await this.db.agent.findMany({
        where: { workspaceId, id: { in: rows.map((r) => r.key!).filter(Boolean) } },
        select: { id: true, name: true },
      });
      for (const a of agents) labels.set(a.id, a.name);
    }
    const out: UsageRow[] = rows.map((r) => ({
      key: r.key ?? "",
      label: labels.get(r.key ?? "") ?? null,
      runs: Number(r.runs),
      inputTokens: Math.round(r.input ?? 0),
      outputTokens: Math.round(r.output ?? 0),
      costUsd: round6(Number(r.cost ?? 0)),
    }));
    const totals = out.reduce(
      (t, r) => ({
        runs: t.runs + r.runs,
        inputTokens: t.inputTokens + r.inputTokens,
        outputTokens: t.outputTokens + r.outputTokens,
        costUsd: round6(t.costUsd + r.costUsd),
      }),
      { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    );
    return { from: from.toISOString(), to: to.toISOString(), groupBy, totals, rows: out };
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
