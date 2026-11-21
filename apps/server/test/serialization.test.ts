import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/shared/config/env.js";
import { closeContext, createContext, type AppContext } from "../src/container.js";
import type { BossQueue } from "../src/execution/queue/boss.js";
import { enqueueRun, JOBS, type SendOptions } from "../src/execution/queue/jobs.js";
import { RunBusyError, RunStore } from "../src/orchestration/runtime/run-store.js";
import { RecordingQueue, resetDb, seedAgent, testContext, waitFor } from "./helpers.js";

/** Regresiones de la revisión (bloque de serialización): H1, M12, M1. */
let ctx: AppContext;
let queue: RecordingQueue;

beforeAll(async () => {
  queue = new RecordingQueue();
  ctx = testContext({ queue });
  await resetDb(ctx);
});
afterAll(async () => {
  await closeContext(ctx);
});

const store = () => new RunStore(ctx.db, ctx.bus);

async function conversationWithRuns(n: number) {
  const ws = await ctx.db.workspace.create({ data: { name: "s", slug: `s-${Date.now()}-${Math.random()}` } });
  const agent = await seedAgent(ctx, ws.id);
  const conv = await ctx.db.conversation.create({ data: { workspaceId: ws.id, agentId: agent.id, channel: "api" } });
  const runs = [];
  for (let i = 0; i < n; i++) {
    runs.push(await ctx.db.run.create({ data: { workspaceId: ws.id, agentId: agent.id, agentVersion: 1, conversationId: conv.id, trigger: "test" } }));
  }
  return { ws, agent, conv, runs };
}

describe("H1 · un run a la vez por conversación", () => {
  it("enqueueRun usa la conversación como grupo y run.process como cola", async () => {
    const { runs, conv } = await conversationWithRuns(1);
    const sent: unknown[] = [];
    await enqueueRun({ send: async (name, data, opts) => (sent.push({ name, data, opts }), "1") }, runs[0]!, "execute");
    expect(sent).toEqual([
      { name: JOBS.runProcess, data: { workspaceId: runs[0]!.workspaceId, runId: runs[0]!.id, kind: "execute" }, opts: { group: { id: conv.id } } },
    ]);
  });

  it("claim rechaza (reintentable) un segundo run de la misma conversación mientras otro está RUNNING", async () => {
    const { runs } = await conversationWithRuns(2);
    const [a, b] = runs as [(typeof runs)[0], (typeof runs)[0]];
    expect(await store().claim(a.workspaceId, a.id, "QUEUED")).toBe(true);
    await expect(store().claim(b.workspaceId, b.id, "QUEUED")).rejects.toBeInstanceOf(RunBusyError);
    expect((await ctx.db.run.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("QUEUED");
    await ctx.db.run.update({ where: { id: a.id }, data: { status: "SUCCEEDED" } });
    expect(await store().claim(b.workspaceId, b.id, "QUEUED")).toBe(true);
  });

  it("claims concurrentes de runs de la misma conversación: exactamente uno gana", async () => {
    const { runs } = await conversationWithRuns(5);
    const results = await Promise.allSettled(runs.map((r) => store().claim(r.workspaceId, r.id, "QUEUED")));
    expect(results.filter((r) => r.status === "fulfilled" && r.value === true)).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(4);
  });

  it("pg-boss: jobs del mismo grupo nunca corren en paralelo; grupos distintos sí", async () => {
    const env = loadEnv(process.env);
    const real = createContext(env);
    const boss = real.boss as BossQueue;
    await boss.start();
    try {
      let active = new Map<string, number>();
      let maxPerGroup = 0;
      let maxTotal = 0;
      const done: string[] = [];
      const ids = { g1: crypto.randomUUID(), g2: crypto.randomUUID() };
      await boss.work(JOBS.runProcess, { concurrency: 4, groupConcurrency: 1 }, async (data) => {
        const group = data.runId.endsWith("1") ? "g1" : "g2";
        active.set(group, (active.get(group) ?? 0) + 1);
        maxPerGroup = Math.max(maxPerGroup, active.get(group)!);
        maxTotal = Math.max(
          maxTotal,
          [...active.values()].reduce((x, y) => x + y, 0),
        );
        await new Promise((r) => setTimeout(r, 300));
        active.set(group, active.get(group)! - 1);
        done.push(data.runId);
      });
      const ws = crypto.randomUUID();
      for (let i = 0; i < 3; i++) {
        await enqueueRun(boss, { workspaceId: ws, id: `00000000-0000-4000-8000-0000000000${i}1`, conversationId: ids.g1 }, "execute");
        await enqueueRun(boss, { workspaceId: ws, id: `00000000-0000-4000-8000-0000000000${i}2`, conversationId: ids.g2 }, "execute");
      }
      await waitFor(async () => done.length === 6, 30_000, 100);
      expect(maxPerGroup).toBe(1);
      expect(maxTotal).toBe(2); // dos conversaciones avanzan a la vez
      active = new Map();
    } finally {
      await closeContext(real);
    }
  });
});

describe("M12 · barrido de runs huérfanos", () => {
  const old = () => new Date(Date.now() - 11 * 60_000);

  it("RUNNING sin latido → se reencola con recover; tras el máximo de intentos → FAILED", async () => {
    const { runs } = await conversationWithRuns(1);
    const run = runs[0]!;
    await ctx.db.run.update({ where: { id: run.id }, data: { status: "RUNNING", heartbeatAt: old() } });
    queue.take(JOBS.runProcess);

    expect(await ctx.sweeper.sweep()).toMatchObject({ recovered: 1 });
    expect(queue.take(JOBS.runProcess).map((j) => j.data)).toEqual([{ workspaceId: run.workspaceId, runId: run.id, kind: "execute", recover: true }]);
    expect(await ctx.sweeper.sweep()).toMatchObject({ recovered: 0 }); // latido renovado: no se reencola en cada pasada

    for (let i = 0; i < 2; i++) {
      await ctx.db.run.update({ where: { id: run.id }, data: { heartbeatAt: old() } });
      expect(await ctx.sweeper.sweep()).toMatchObject({ recovered: 1 });
    }
    await ctx.db.run.update({ where: { id: run.id }, data: { heartbeatAt: old() } });
    expect(await ctx.sweeper.sweep()).toMatchObject({ failed: 1 });
    const final = await ctx.db.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(final).toMatchObject({ status: "FAILED", recoveries: 3 });
    expect(await ctx.db.event.findFirst({ where: { subject: `run:${run.id}`, type: "run.finished" } })).not.toBeNull();
  });

  it("QUEUED olvidado → reencolado; WAITING_APPROVAL con aprobación pendiente → se respeta; sin pendientes → resume", async () => {
    const { runs } = await conversationWithRuns(3);
    const [queued, waiting, decided] = runs as [(typeof runs)[0], (typeof runs)[0], (typeof runs)[0]];
    await ctx.db.run.update({ where: { id: queued.id }, data: { heartbeatAt: old() } });
    await ctx.db.run.updateMany({ where: { id: { in: [waiting.id, decided.id] } }, data: { status: "WAITING_APPROVAL", heartbeatAt: old() } });
    const approval = (runId: string, status: "PENDING" | "APPROVED") => ({
      workspaceId: waiting.workspaceId,
      runId,
      toolName: "email.send",
      toolCallId: `c-${runId}`,
      args: {},
      preview: "x",
      mode: "ASK_OWNER" as const,
      idempotencyKey: `k-${runId}`,
      expiresAt: new Date(Date.now() + 3600_000),
      status,
    });
    await ctx.db.approval.create({ data: approval(waiting.id, "PENDING") });
    await ctx.db.approval.create({ data: approval(decided.id, "APPROVED") });
    queue.take(JOBS.runProcess);

    expect(await ctx.sweeper.sweep()).toMatchObject({ requeued: 1, resumed: 1, recovered: 0 });
    const jobs = queue.take(JOBS.runProcess).map((j) => j.data as { runId: string; kind: string });
    expect(jobs).toEqual(
      expect.arrayContaining([expect.objectContaining({ runId: queued.id, kind: "execute" }), expect.objectContaining({ runId: decided.id, kind: "resume" })]),
    );
    expect(jobs.some((j) => j.runId === waiting.id)).toBe(false);
  });
});

describe("M1 · sin singletonKey", () => {
  it("SendOptions ya no acepta singletonKey (la deduplicación vive en los consumidores)", () => {
    // @ts-expect-error singletonKey eliminado a propósito: no deduplica en colas standard de pg-boss
    const opts: SendOptions = { singletonKey: "x" };
    expect(opts).toBeDefined();
  });

  it("un inbound duplicado (mismo channelMessageId) solo crea un mensaje y un run", async () => {
    const { ws, conv } = await conversationWithRuns(0);
    const input = {
      workspaceId: ws.id,
      conversationId: conv.id,
      text: "hola",
      author: "CONTACT" as const,
      channelMessageId: "wamid.1",
      trigger: "channel.inbound",
    };
    await ctx.conversations.receive(input);
    await ctx.conversations.receive(input);
    expect(await ctx.db.message.count({ where: { conversationId: conv.id } })).toBe(1);
    expect(await ctx.db.run.count({ where: { conversationId: conv.id } })).toBe(1);
  });
});
