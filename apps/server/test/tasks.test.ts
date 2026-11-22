import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/access/http/app.js";
import { closeContext, type AppContext } from "../src/container.js";
import { builtinTools } from "../src/integrations/tools/builtin/index.js";
import { leadTools } from "../src/integrations/tools/builtin/leads.js";
import { ToolRegistry } from "../src/integrations/tools/registry.js";
import { defineTool, type ToolDef } from "../src/integrations/tools/types.js";
import { StaticLlmResolver } from "../src/orchestration/llm/registry.js";
import { RecordingQueue, resetDb, scriptedModel, seedWorkspace, testContext, type ScriptedTurn } from "./helpers.js";

/**
 * Runtime autónomo (ADR 003 · ROADMAP E2, E3, E5, E10, E8): Task, plan, cupos, esperas, delegación y auditoría.
 * El modelo se simula con un guion; los jobs se procesan a mano desde la cola en memoria.
 */
let effects: Array<{ tool: string; input: unknown }> = [];
const fakeTools = [
  defineTool({
    name: "crm.lookup",
    description: "Busca datos del cliente",
    input: z.object({ q: z.string() }),
    scope: "crm:read",
    risk: "read",
    approval: "NEVER",
    async execute(input) {
      effects.push({ tool: "crm.lookup", input });
      return { ok: true, found: [{ name: "Ana", status: "fría" }] };
    },
  }),
  defineTool({
    name: "email.send",
    description: "Envía un correo",
    input: z.object({ to: z.string(), body: z.string() }),
    scope: "channel:send",
    risk: "send",
    approval: "NEVER", // la política del tenant (send = aprobación) lo endurece
    async execute(input) {
      effects.push({ tool: "email.send", input });
      return { ok: true };
    },
  }),
  defineTool({
    name: "content.publish",
    description: "Publica un post",
    input: z.object({ text: z.string() }),
    scope: "content:publish",
    risk: "send",
    approval: "NEVER",
    async execute(input) {
      effects.push({ tool: "content.publish", input });
      return { ok: true };
    },
  }),
] as ToolDef[];

let ctx: AppContext;
let app: FastifyInstance;
let queue: RecordingQueue;
let script: ScriptedTurn[] = [];
let calls = 0;

/** El guion de cada test se fija con useScript(); el modelo lee de la variable compartida. */
function useScript(turns: ScriptedTurn[]) {
  script = turns;
  calls = 0;
}
const model = () => {
  const turns = script;
  const offset = calls;
  const m = scriptedModel(turns.slice(offset));
  const doStream = m.model.doStream.bind(m.model);
  m.model.doStream = async (opts) => {
    calls++;
    return doStream(opts);
  };
  return m.model;
};

beforeAll(async () => {
  queue = new RecordingQueue();
  const tools = new ToolRegistry();
  for (const t of [...builtinTools, ...fakeTools]) tools.register(t);
  ctx = testContext({ tools, queue, llm: new StaticLlmResolver(model, { provider: "mistral", region: "eu" }) });
  for (const t of leadTools(ctx.leads)) tools.register(t);
  await resetDb(ctx);
  app = await buildApp(ctx);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closeContext(ctx);
});
beforeEach(() => {
  effects = [];
  queue.jobs.length = 0;
});

let n = 0;
async function setupWs(tools: string[] = ["crm.lookup", "email.send", "content.publish"]) {
  const w = await seedWorkspace(ctx, `t${++n}-${Date.now()}`);
  const agent = await ctx.db.agent.create({
    data: { workspaceId: w.workspace.id, name: "Asistente", instructions: "Ayuda al dueño.", model: "mistral:mistral-medium-latest", toolConfig: { tools } },
  });
  return { ...w, agent };
}

async function createTask(w: Awaited<ReturnType<typeof setupWs>>, body: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/v1/tasks", headers: w.auth, payload: { agentId: w.agent.id, ...body } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; status: string };
}

/** Procesa los jobs encolados (tramos y despertares). Los despertares con fecha futura se saltan salvo timers=true. */
async function drain(opts: { timers?: boolean; max?: number } = {}) {
  for (let i = 0; i < (opts.max ?? 30); i++) {
    const idx = queue.jobs.findIndex(
      (j) => (j.name === "run.process" || j.name === "task.wake") && (opts.timers || !j.opts?.runAt || j.opts.runAt <= new Date()),
    );
    if (idx < 0) return;
    const [job] = queue.jobs.splice(idx, 1);
    const d = job!.data as { workspaceId: string; runId: string; kind: string; taskId: string; signal: "timer"; waitToken?: string };
    if (job!.name === "run.process") await (d.kind === "resume" ? ctx.runtime.resume(d.workspaceId, d.runId) : ctx.runtime.execute(d.workspaceId, d.runId));
    else await ctx.runtime.wake(d.workspaceId, d.taskId, d.signal, d.waitToken);
  }
}

const task = (id: string) => ctx.db.task.findUniqueOrThrow({ where: { id } });
const events = async (taskId: string) => (await ctx.db.event.findMany({ where: { subject: `task:${taskId}` }, orderBy: { seq: "asc" } })).map((e) => e.type);

describe("E2 · Task desde la app", () => {
  it("POST /v1/tasks crea una Task PLANNING y su primer tramo; el workspace sale del principal", async () => {
    const w = await setupWs();
    const other = await seedWorkspace(ctx, `otro-${Date.now()}`);
    useScript([{ text: "Hecho." }]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: w.auth,
      payload: { agentId: w.agent.id, goal: "Resume las ventas", workspaceId: other.workspace.id },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ status: "PLANNING", source: "APP", goal: "Resume las ventas", limits: { maxSteps: 40 } });
    const row = await task(body.id);
    expect(row.workspaceId).toBe(w.workspace.id);
    const runs = await ctx.db.run.findMany({ where: { taskId: body.id } });
    expect(runs).toHaveLength(1);
    expect(queue.jobs.filter((j) => j.name === "run.process")).toHaveLength(1);
    // Un agente de otro workspace no se puede usar.
    const foreign = await app.inject({ method: "POST", url: "/v1/tasks", headers: other.auth, payload: { agentId: w.agent.id, goal: "x" } });
    expect(foreign.statusCode).toBe(404);
  });

  it("loop: plan → investigar → resultado; el plan se versiona, el bus cuenta los pasos y no se abre ningún hilo de WhatsApp", async () => {
    const w = await setupWs();
    useScript([
      {
        toolCalls: [
          {
            id: "p1",
            name: "plan__update",
            input: {
              steps: [
                { id: "a", title: "Buscar leads fríos", status: "doing" },
                { id: "b", title: "Redactar borrador", status: "pending" },
              ],
            },
          },
        ],
      },
      { toolCalls: [{ id: "c1", name: "crm__lookup", input: { q: "leads fríos" } }] },
      { text: "Borrador: Hola Ana, ¿retomamos la propuesta?" },
    ]);
    const t = await createTask(w, { goal: "Arma el seguimiento de los leads fríos y déjame el borrador", context: {} });
    await drain();
    const row = await task(t.id);
    expect(row).toMatchObject({ status: "SUCCEEDED", planVersion: 1, result: "Borrador: Hola Ana, ¿retomamos la propuesta?" });
    expect((row.plan as Array<{ id: string }>).map((s) => s.id)).toEqual(["a", "b"]);
    expect(row.spentSteps).toBe(5); // 3 llamadas al modelo + 2 tools
    expect(Number(row.spentCostUsd)).toBeGreaterThan(0);
    expect(effects.map((e) => e.tool)).toEqual(["crm.lookup"]);
    expect(await events(t.id)).toEqual(expect.arrayContaining(["task.created", "task.plan", "task.status", "task.step", "task.finished"]));
    expect(await ctx.db.conversation.count({ where: { workspaceId: w.workspace.id } })).toBe(0);
    expect(await ctx.db.message.count({ where: { workspaceId: w.workspace.id } })).toBe(0);
    const run = await ctx.db.run.findFirstOrThrow({ where: { taskId: t.id } });
    expect(Number(run.costUsd)).toBeCloseTo(Number(row.spentCostUsd), 6); // E3: el costo del tramo sigue en Run.costUsd
  });

  it("GET /v1/tasks y /v1/tasks/:id: aislamiento por workspace", async () => {
    const w = await setupWs();
    const other = await seedWorkspace(ctx, `iso-${Date.now()}`);
    useScript([{ text: "ok" }]);
    const t = await createTask(w, { goal: "Algo" });
    expect((await app.inject({ method: "GET", url: `/v1/tasks/${t.id}`, headers: w.auth })).json()).toMatchObject({ id: t.id, runs: [{ trigger: "task" }] });
    expect((await app.inject({ method: "GET", url: `/v1/tasks/${t.id}`, headers: other.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/tasks", headers: other.auth })).json().data).toEqual([]);
  });
});

describe("E3 · cupos", () => {
  it("pasos: al agotarse queda BLOCKED sin otra llamada al modelo; ampliar el cupo la retoma desde el checkpoint", async () => {
    const w = await setupWs();
    useScript([
      { toolCalls: [{ id: "c1", name: "crm__lookup", input: { q: "1" } }] },
      { toolCalls: [{ id: "c2", name: "crm__lookup", input: { q: "2" } }] },
      { toolCalls: [{ id: "c3", name: "crm__lookup", input: { q: "3" } }] },
      { text: "Listo tras ampliar." },
    ]);
    const t = await createTask(w, { goal: "Investiga a fondo", limits: { maxSteps: 4 } });
    await drain();
    let row = await task(t.id);
    expect(row).toMatchObject({ status: "BLOCKED", blockedReason: "steps", spentSteps: 4 });
    expect(calls).toBe(2);
    expect((await ctx.db.run.findFirstOrThrow({ where: { taskId: t.id } })).status).toBe("BLOCKED");
    expect(await events(t.id)).toContain("task.blocked");

    // Ampliar por debajo de lo gastado no sirve.
    expect((await app.inject({ method: "POST", url: `/v1/tasks/${t.id}/limits`, headers: w.auth, payload: { maxSteps: 3 } })).statusCode).toBe(409);
    const ok = await app.inject({ method: "POST", url: `/v1/tasks/${t.id}/limits`, headers: w.auth, payload: { maxSteps: 20 } });
    expect(ok.statusCode).toBe(200);
    expect(queue.jobs.filter((j) => j.name === "task.wake")).toHaveLength(1);
    await drain();
    row = await task(t.id);
    expect(row).toMatchObject({ status: "SUCCEEDED", result: "Listo tras ampliar." });
    const runs = await ctx.db.run.findMany({ where: { taskId: t.id }, orderBy: { createdAt: "asc" } });
    expect(runs.map((r) => r.trigger)).toEqual(["task", "task.wake"]);
    // El segundo tramo arrancó desde el checkpoint: el modelo vio los resultados anteriores y la nota de la plataforma.
    expect(JSON.stringify(runs[1]!.checkpoint)).toContain("amplió el cupo");
  });

  it("costo: se corta al pasar el presupuesto, antes de la siguiente llamada", async () => {
    const w = await setupWs();
    useScript([
      { toolCalls: [{ id: "c1", name: "crm__lookup", input: { q: "1" } }] },
      { toolCalls: [{ id: "c2", name: "crm__lookup", input: { q: "2" } }] },
      { text: "no debería llegar" },
    ]);
    const t = await createTask(w, { goal: "Algo caro", limits: { maxCostUsd: 0.000008 } }); // cada paso simulado cuesta 0,0000045
    await drain();
    expect(await task(t.id)).toMatchObject({ status: "BLOCKED", blockedReason: "cost" });
    expect(calls).toBe(2);
  });

  it("tiempo: con el cupo de tiempo gastado no hay ninguna llamada al modelo", async () => {
    const w = await setupWs();
    useScript([{ text: "no debería llegar" }]);
    const t = await createTask(w, { goal: "Algo lento", limits: { maxDurationMs: 60_000 } });
    await ctx.db.task.update({ where: { id: t.id }, data: { elapsedMs: 61_000 } });
    await drain();
    expect(await task(t.id)).toMatchObject({ status: "BLOCKED", blockedReason: "time" });
    expect(calls).toBe(0);
  });
});

describe("E4/E5 · riesgo, aprobaciones y casos de uso", () => {
  it("seguimiento de un lead: mueve la etapa sola (write interno) y el envío (send) queda esperando aprobación; la espera no gasta pasos y pausa el reloj", async () => {
    const w = await setupWs(["crm.lookup", "email.send", "lead.move"]);
    const stages = await ctx.leads.stages(w.workspace.id);
    const contact = await ctx.db.contact.create({ data: { workspaceId: w.workspace.id, name: "Sol" } });
    const lead = await ctx.db.lead.create({ data: { workspaceId: w.workspace.id, contactId: contact.id, title: "Clínica Sol", stageId: stages[0]!.id } });
    const target = stages[1]!.name;
    useScript([
      { toolCalls: [{ id: "m1", name: "lead__move", input: { leadId: lead.id, stage: target } }] },
      { toolCalls: [{ id: "e1", name: "email__send", input: { to: "sol@x.com", body: "¿Retomamos?" } }] },
      { text: "Correo enviado y lead movido." },
    ]);
    const t = await createTask(w, { goal: "Haz el seguimiento de este lead", context: { leadId: lead.id } });
    await drain();
    expect((await ctx.db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } })).stage.name).toBe(target);
    let row = await task(t.id);
    expect(row.status).toBe("WAITING_APPROVAL");
    expect(row.segmentStartedAt).toBeNull(); // reloj pausado
    const stepsAtPause = row.spentSteps;
    expect(effects.some((e) => e.tool === "email.send")).toBe(false);
    const approval = await ctx.db.approval.findFirstOrThrow({ where: { workspaceId: w.workspace.id, status: "PENDING" } });
    expect(approval.toolName).toBe("email.send");

    // Mientras espera no se gasta nada; un OWNER/ADMIN (approvals:write) decide y el tramo sigue.
    expect((await task(t.id)).spentSteps).toBe(stepsAtPause);
    const decide = await app.inject({ method: "POST", url: `/v1/approvals/${approval.id}/approve`, headers: w.auth, payload: {} });
    expect(decide.statusCode).toBe(200);
    await drain();
    row = await task(t.id);
    expect(row.status).toBe("SUCCEEDED");
    expect(effects.filter((e) => e.tool === "email.send")).toHaveLength(1);
  });

  it("un contexto que apunta a un lead de otro workspace se rechaza", async () => {
    const w = await setupWs();
    const other = await setupWs();
    const stages = await ctx.leads.stages(other.workspace.id);
    const contact = await ctx.db.contact.create({ data: { workspaceId: other.workspace.id, name: "Ajeno" } });
    const lead = await ctx.db.lead.create({ data: { workspaceId: other.workspace.id, contactId: contact.id, title: "Ajeno", stageId: stages[0]!.id } });
    const res = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: w.auth,
      payload: { agentId: w.agent.id, goal: "x", context: { leadId: lead.id } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("contenido: deja el borrador como resultado; si intenta publicar (send) pide aprobación y el rechazo informa al modelo sin publicar", async () => {
    const w = await setupWs();
    useScript([
      { toolCalls: [{ id: "pub", name: "content__publish", input: { text: "Post de prueba" } }] },
      { text: "No se publicó. Borrador: Post de prueba" },
    ]);
    const t = await createTask(w, { goal: "Escribe un post para Instagram sobre la oferta de otoño" });
    await drain();
    const approval = await ctx.db.approval.findFirstOrThrow({ where: { workspaceId: w.workspace.id, status: "PENDING" } });
    const res = await app.inject({ method: "POST", url: `/v1/approvals/${approval.id}/reject`, headers: w.auth, payload: { reason: "Aún no" } });
    expect(res.statusCode).toBe(200);
    await drain();
    expect(effects.some((e) => e.tool === "content.publish")).toBe(false);
    const row = await task(t.id);
    expect(row).toMatchObject({ status: "SUCCEEDED", result: "No se publicó. Borrador: Post de prueba" });
    const runs = await ctx.db.run.findMany({ where: { taskId: t.id } });
    expect(JSON.stringify(runs[0]!.checkpoint)).toContain("rechazó");
  });

  it("cancelar: deja de gastar, rechaza lo que esperaba aprobación y no lo envía", async () => {
    const w = await setupWs();
    useScript([{ toolCalls: [{ id: "e1", name: "email__send", input: { to: "a@x.com", body: "hola" } }] }, { text: "no debería llegar" }]);
    const t = await createTask(w, { goal: "Escribe a Ana" });
    await drain();
    expect((await task(t.id)).status).toBe("WAITING_APPROVAL");
    const res = await app.inject({ method: "POST", url: `/v1/tasks/${t.id}/cancel`, headers: w.auth, payload: {} });
    expect(res.statusCode).toBe(204);
    expect(await task(t.id)).toMatchObject({ status: "CANCELLED" });
    expect((await ctx.db.approval.findFirstOrThrow({ where: { workspaceId: w.workspace.id } })).status).toBe("REJECTED");
    await drain();
    expect(effects).toEqual([]);
    expect(calls).toBe(1);
    expect((await app.inject({ method: "POST", url: `/v1/tasks/${t.id}/cancel`, headers: w.auth, payload: {} })).statusCode).toBe(409);
  });
});

describe("Esperas durables (WAITING_EXTERNAL)", () => {
  it("task.wait sin fecha: espera un dato del dueño; /signal la despierta con ese dato en un tramo nuevo", async () => {
    const w = await setupWs();
    useScript([{ toolCalls: [{ id: "w1", name: "task__wait", input: { reason: "Necesito el precio de la oferta" } }] }, { text: "Oferta preparada a 49 €." }]);
    const t = await createTask(w, { goal: "Prepara la oferta" });
    await drain();
    let row = await task(t.id);
    expect(row.status).toBe("WAITING_EXTERNAL");
    expect(row.waiting).toMatchObject({ kind: "external", reason: "Necesito el precio de la oferta" });
    expect(calls).toBe(1);
    expect((await app.inject({ method: "POST", url: `/v1/tasks/${t.id}/signal`, headers: w.auth, payload: { message: "49 €" } })).statusCode).toBe(202);
    await drain();
    row = await task(t.id);
    expect(row).toMatchObject({ status: "SUCCEEDED", result: "Oferta preparada a 49 €." });
    const runs = await ctx.db.run.findMany({ where: { taskId: t.id }, orderBy: { createdAt: "asc" } });
    expect(JSON.stringify(runs[1]!.checkpoint)).toContain("49 €");
    // Una señal repetida no abre otro tramo.
    expect(await ctx.runtime.wake(w.workspace.id, t.id, "external")).toBeUndefined();
    expect(await ctx.db.run.count({ where: { taskId: t.id } })).toBe(2);
  });

  it("task.wait con fecha: programa el despertar (startAfter) y un plazo viejo no despierta una espera nueva", async () => {
    const w = await setupWs();
    const until = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
    useScript([{ toolCalls: [{ id: "w1", name: "task__wait", input: { reason: "Esperar 3 días a la respuesta", until } }] }, { text: "Retomado." }]);
    const t = await createTask(w, { goal: "Vuelve a escribir si no responde" });
    await drain();
    const wake = queue.jobs.find((j) => j.name === "task.wake")!;
    expect(wake.opts?.runAt?.toISOString()).toBe(until);
    expect(wake.data).toMatchObject({ signal: "timer", taskId: t.id });
    await ctx.runtime.wake(w.workspace.id, t.id, "timer", "token-viejo");
    expect((await task(t.id)).status).toBe("WAITING_EXTERNAL");
    await drain({ timers: true });
    expect(await task(t.id)).toMatchObject({ status: "SUCCEEDED", result: "Retomado." });
  });
});

describe("E10 · delegación", () => {
  it("la madre delega, queda WAITING_CHILD, la hija termina y la madre sigue con su resultado; el costo de la hija suma a la madre", async () => {
    const w = await setupWs();
    useScript([
      { toolCalls: [{ id: "d1", name: "task__delegate", input: { goal: "Busca tres ideas de post" } }] }, // madre
      { text: "Ideas: A, B, C" }, // hija
      { text: "Plan final con A, B y C" }, // madre, tras despertar
    ]);
    const t = await createTask(w, { goal: "Plan de contenidos del mes" });
    await drain({ max: 1 });
    const parent = await task(t.id);
    expect(parent.status).toBe("WAITING_CHILD");
    const child = await ctx.db.task.findFirstOrThrow({ where: { parentTaskId: t.id } });
    expect(child).toMatchObject({ source: "DELEGATION", depth: 1, launchedBy: `task:${t.id}` });
    await drain();
    expect(await task(child.id)).toMatchObject({ status: "SUCCEEDED", result: "Ideas: A, B, C" });
    const done = await task(t.id);
    expect(done).toMatchObject({ status: "SUCCEEDED", result: "Plan final con A, B y C" });
    const runs = await ctx.db.run.findMany({ where: { taskId: t.id }, orderBy: { createdAt: "asc" } });
    expect(JSON.stringify(runs[1]!.checkpoint)).toContain("Ideas: A, B, C");
    // costo madre = sus dos tramos + el de la hija
    const own = runs.reduce((s, r) => s + Number(r.costUsd), 0);
    const childDone = await task(child.id);
    expect(Number(childDone.spentCostUsd)).toBeGreaterThan(0);
    expect(Number(done.spentCostUsd)).toBeCloseTo(own + Number(childDone.spentCostUsd), 6);
  });

  it("profundidad máxima 3: una tarea de nivel 3 no puede delegar", async () => {
    const w = await setupWs();
    useScript([{ toolCalls: [{ id: "d1", name: "task__delegate", input: { goal: "Otra más" } }] }, { text: "No pude delegar, lo hago yo." }]);
    const t = await createTask(w, { goal: "Profunda" });
    await ctx.db.task.update({ where: { id: t.id }, data: { depth: 3 } });
    await drain();
    expect(await task(t.id)).toMatchObject({ status: "SUCCEEDED" });
    expect(await ctx.db.task.count({ where: { parentTaskId: t.id } })).toBe(0);
  });

  it("cancelar la madre cancela a la hija", async () => {
    const w = await setupWs();
    useScript([{ toolCalls: [{ id: "d1", name: "task__delegate", input: { goal: "Hija lenta" } }] }]);
    const t = await createTask(w, { goal: "Madre" });
    await drain({ max: 1 });
    const child = await ctx.db.task.findFirstOrThrow({ where: { parentTaskId: t.id } });
    await app.inject({ method: "POST", url: `/v1/tasks/${t.id}/cancel`, headers: w.auth, payload: {} });
    expect((await task(child.id)).status).toBe("CANCELLED");
  });
});

describe("E8 · auditoría de cada tramo", () => {
  it("registra objetivo, decisión, datos, tools con riesgo y aprobación, modelo, proveedor, región, resultado y costo, sin secretos", async () => {
    const w = await setupWs();
    useScript([{ toolCalls: [{ id: "c1", name: "crm__lookup", input: { q: "Ana" } }] }, { text: "Ana está fría. Propongo escribirle el lunes." }]);
    const t = await createTask(w, { goal: "Revisa a Ana" });
    await drain();
    const log = await ctx.db.auditLog.findFirstOrThrow({ where: { workspaceId: w.workspace.id, action: "task.segment" } });
    expect(log.data).toMatchObject({
      taskId: t.id,
      source: "APP",
      outcome: "SUCCEEDED",
      goal: "Revisa a Ana",
      decision: "Ana está fría.",
      tools: [{ name: "crm.lookup", risk: "read", approval: "none", result: "ok" }],
      model: { provider: "mistral", region: "eu", id: "mistral:mistral-medium-latest" },
    });
    expect((log.data as { costUsd: number }).costUsd).toBeGreaterThan(0);
    expect(JSON.stringify(log.data)).not.toMatch(/apiKey|secret|found/); // ni claves ni el payload de la tool
  });
});

describe("Puerta de canal (WhatsApp/API chat)", () => {
  it("un mensaje abre una tarea CHANNEL corta atada al hilo, sin tools de tarea", async () => {
    const w = await setupWs(["crm.lookup"]);
    const conv = await ctx.conversations.createApiChat(w.workspace.id, w.agent.id);
    useScript([{ text: "¡Hola!" }]);
    const r = await ctx.conversations.receive({ workspaceId: w.workspace.id, conversationId: conv.id, text: "hola", author: "HUMAN", trigger: "api.chat" });
    expect(r.status).toBe("run_queued");
    await drain();
    const t = await ctx.db.task.findFirstOrThrow({ where: { workspaceId: w.workspace.id, conversationId: conv.id } });
    expect(t).toMatchObject({ source: "CHANNEL", status: "SUCCEEDED", limits: { maxSteps: 12 } });
  });
});

describe("Durabilidad", () => {
  it("si el despertar se perdió, el barrido lo reintenta; y /v1/events sirve el subject task:<id>", async () => {
    const w = await setupWs();
    useScript([
      { toolCalls: [{ id: "w1", name: "task__wait", input: { reason: "Dato", until: new Date(Date.now() + 60_000).toISOString() } }] },
      { text: "Seguí." },
    ]);
    const t = await createTask(w, { goal: "Espera corta" });
    await drain();
    queue.jobs.length = 0; // el job de despertar se perdió
    const past = new Date(Date.now() - 10 * 60_000);
    await ctx.db.task.update({
      where: { id: t.id },
      data: { waiting: { ...((await task(t.id)).waiting as object), until: past.toISOString() }, updatedAt: past },
    });
    const r = await ctx.sweeper.sweep();
    expect(r.woken).toBe(1);
    await drain();
    expect(await task(t.id)).toMatchObject({ status: "SUCCEEDED", result: "Seguí." });
    const ev = await app.inject({ method: "GET", url: `/v1/events?subject=task:${t.id}`, headers: w.auth });
    expect(ev.statusCode).toBe(200);
    expect(ev.json().data.map((e: { type: string }) => e.type)).toContain("task.finished");
  });

  it("si el worker muere a mitad de un tramo, se retoma sin repetir un efecto ya hecho", async () => {
    const w = await setupWs();
    const policy = await ctx.db.workspace.findUniqueOrThrow({ where: { id: w.workspace.id } });
    await ctx.db.workspace.update({ where: { id: w.workspace.id }, data: { settings: { ...(policy.settings as object), riskPolicy: { send: "direct" } } } });
    useScript([
      { toolCalls: [{ id: "e1", name: "email__send", input: { to: "a@x.com", body: "hola" } }] },
      { text: "Enviado." },
      { toolCalls: [{ id: "e9", name: "email__send", input: { to: "a@x.com", body: "hola" } }] }, // al recuperar, el modelo repite
      { text: "Enviado." },
    ]);
    const t = await createTask(w, { goal: "Escribe a Ana" });
    await drain();
    expect(effects.filter((e) => e.tool === "email.send")).toHaveLength(1);
    // Simula la caída antes de cerrar: el tramo vuelve a RUNNING sin checkpoint y la tarea sigue abierta.
    const run = await ctx.db.run.findFirstOrThrow({ where: { taskId: t.id } });
    await ctx.db.run.update({ where: { id: run.id }, data: { status: "RUNNING", checkpoint: [], stepCount: 0, heartbeatAt: new Date(Date.now() - 120_000) } });
    await ctx.db.task.update({ where: { id: t.id }, data: { status: "RUNNING", finishedAt: null, result: null } });
    await ctx.runtime.execute(w.workspace.id, run.id, 1);
    expect(effects.filter((e) => e.tool === "email.send")).toHaveLength(1);
    expect((await task(t.id)).status).toBe("SUCCEEDED");
  });
});
