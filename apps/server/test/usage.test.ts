import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/access/http/app.js";
import { closeContext, type AppContext } from "../src/container.js";
import { StaticLlmResolver } from "../src/orchestration/llm/registry.js";
import { estimateCostUsd, pricingOf } from "../src/shared/observability/cost.js";
import { metricsRegistry } from "../src/shared/observability/metrics.js";
import { RecordingQueue, resetDb, scriptedModel, seedWorkspace, testContext } from "./helpers.js";

/** E3: el coste usa la tarifa de la conexión y /v1/usage lo agrega por día, agente y modelo. */
let ctx: AppContext;
let app: FastifyInstance;
const queue = new RecordingQueue();
// Tarifa de la conexión: 1000 USD/M de entrada y 2000 USD/M de salida. El guion consume 10 + 5 tokens por paso → 0,02 USD.
const PRICING = { inputPer1M: 1000, outputPer1M: 2000 };
beforeAll(async () => {
  ctx = testContext({
    queue,
    llm: new StaticLlmResolver(() => scriptedModel([{ text: "Hecho." }]).model, { provider: "mistral", region: "eu", pricing: PRICING }),
  });
  await resetDb(ctx);
  app = await buildApp(ctx);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closeContext(ctx);
});

async function drain() {
  for (let i = 0; i < 20; i++) {
    const idx = queue.jobs.findIndex((j) => j.name === "run.process");
    if (idx < 0) return;
    const [job] = queue.jobs.splice(idx, 1);
    const d = job!.data as { workspaceId: string; runId: string };
    await ctx.runtime.execute(d.workspaceId, d.runId);
  }
}

describe("Costes y consumo", () => {
  it("tarifa: sin pricing se usa la de referencia; con pricing, la de la conexión", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostUsd(u)).toBe(0.75);
    expect(estimateCostUsd(u, pricingOf({ pricing: { inputPer1M: 2, outputPer1M: 6 } }))).toBe(8);
    expect(pricingOf({ pricing: { inputPer1M: "2" } })).toBeUndefined();
  });

  it("el run y la task se cobran con la tarifa de la conexión y /v1/usage los agrega", async () => {
    const w = await seedWorkspace(ctx, `u-${Date.now()}`);
    const other = await seedWorkspace(ctx, `u2-${Date.now()}`);
    const agentA = await ctx.db.agent.create({
      data: { workspaceId: w.workspace.id, name: "Recepción", instructions: "x", model: "mistral:mistral-small-latest" },
    });
    const agentB = await ctx.db.agent.create({
      data: { workspaceId: w.workspace.id, name: "Ventas", instructions: "x", model: "mistral:mistral-medium-latest" },
    });
    const agentO = await ctx.db.agent.create({
      data: { workspaceId: other.workspace.id, name: "Otro", instructions: "x", model: "mistral:mistral-small-latest" },
    });
    for (const [auth, agent] of [
      [w.auth, agentA],
      [w.auth, agentA],
      [w.auth, agentB],
      [other.auth, agentO],
    ] as const) {
      expect((await app.inject({ method: "POST", url: "/v1/tasks", headers: auth, payload: { agentId: agent.id, goal: "Resume el día" } })).statusCode).toBe(
        201,
      );
    }
    await drain();
    const runs = await ctx.db.run.findMany({ where: { workspaceId: w.workspace.id } });
    expect(runs).toHaveLength(3);
    for (const r of runs) {
      expect(Number(r.costUsd)).toBeCloseTo(0.02, 6);
      expect(r.model).toMatch(/^mistral:/);
    }

    const byModel = await app.inject({ method: "GET", url: "/v1/usage?groupBy=model", headers: w.auth });
    expect(byModel.statusCode).toBe(200);
    expect(byModel.json().totals).toEqual({ runs: 3, inputTokens: 30, outputTokens: 15, costUsd: 0.06 });
    expect(byModel.json().rows).toEqual([
      expect.objectContaining({ key: "mistral:mistral-small-latest", runs: 2, costUsd: 0.04 }),
      expect.objectContaining({ key: "mistral:mistral-medium-latest", runs: 1, costUsd: 0.02 }),
    ]);
    const byAgent = (await app.inject({ method: "GET", url: "/v1/usage?groupBy=agent", headers: w.auth })).json();
    expect(byAgent.rows[0]).toMatchObject({ key: agentA.id, label: "Recepción", runs: 2 });
    const byDay = (await app.inject({ method: "GET", url: "/v1/usage", headers: w.auth })).json();
    expect(byDay.rows).toEqual([expect.objectContaining({ key: new Date().toISOString().slice(0, 10), runs: 3 })]);

    const past = encodeURIComponent(new Date(Date.now() - 10 * 86_400_000).toISOString());
    const pastTo = encodeURIComponent(new Date(Date.now() - 5 * 86_400_000).toISOString());
    expect((await app.inject({ method: "GET", url: `/v1/usage?from=${past}&to=${pastTo}`, headers: w.auth })).json().totals.runs).toBe(0);
    expect((await app.inject({ method: "GET", url: `/v1/usage?from=${pastTo}&to=${past}`, headers: w.auth })).statusCode).toBe(400);

    const metrics = await metricsRegistry.getSingleMetricAsString("ega_llm_cost_usd_total");
    expect(metrics).toMatch(/provider="mistral"\} 0\.08/);
  });

  it("exige usage:read", async () => {
    const op = await seedWorkspace(ctx, `u3-${Date.now()}`, ["runs:read"]);
    expect((await app.inject({ method: "GET", url: "/v1/usage", headers: op.auth })).statusCode).toBe(403);
  });
});
