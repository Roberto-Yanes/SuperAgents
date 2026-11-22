import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../../container.js";
import { principalOf, requireScopes } from "../plugins/auth.js";

export type UsageDeps = Pick<AppContext, "usage">;

const Totals = z.object({ runs: z.number(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() });
const UsageOut = z.object({
  from: z.string(),
  to: z.string(),
  groupBy: z.enum(["day", "agent", "model"]),
  totals: Totals,
  rows: z.array(Totals.extend({ key: z.string(), label: z.string().nullable() })),
});

/** Consumo de LLM del workspace (E3): runs, tokens y coste estimado agregados. */
export const usageRoutes: FastifyPluginAsyncZod<{ deps: UsageDeps }> = async (app, { deps }) => {
  app.get(
    "/v1/usage",
    {
      preHandler: requireScopes("usage:read"),
      schema: {
        tags: ["usage"],
        querystring: z.object({
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          groupBy: z.enum(["day", "agent", "model"]).default("day"),
        }),
        response: { 200: UsageOut },
      },
    },
    async (req) =>
      deps.usage.report(principalOf(req).workspaceId, {
        ...(req.query.from ? { from: new Date(req.query.from) } : {}),
        ...(req.query.to ? { to: new Date(req.query.to) } : {}),
        groupBy: req.query.groupBy,
      }),
  );
};
