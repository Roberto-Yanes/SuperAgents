import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/access/http/app.js";
import { createUserWithPassword } from "../src/access/auth/better-auth.js";
import { loadEnv } from "../src/shared/config/env.js";
import { closeContext, createContext, type AppContext } from "../src/container.js";
import { systemActor } from "../src/data/audit.js";
import { assertEuResidency, type LlmPolicy } from "../src/domain/connections/llm-residency.js";
import { applyRiskPolicy, DEFAULT_RISK_POLICY } from "../src/domain/workspaces/risk-policy.js";
import { JOBS } from "../src/execution/queue/jobs.js";
import { JobWaitPort, MemoryJobPort } from "../src/execution/queue/ports.js";
import { ConnectionLlmResolver } from "../src/orchestration/llm/registry.js";
import { createLogger } from "../src/shared/observability/logger.js";
import { RecordingQueue, resetDb, seedWorkspace, testContext } from "./helpers.js";

/** E1 (puerto de jobs), E4 (riesgo por tenant), E7 (LLM en la UE) y logs sin ticket (E8). */

describe("E1 · puerto de jobs y esperas (sin Postgres)", () => {
  it("las esperas de tareas se encolan por el puerto, con fecha y grupo, sin nombrar pg-boss", async () => {
    const jobs = new MemoryJobPort();
    const waits = new JobWaitPort(jobs);
    const at = new Date(Date.now() + 86_400_000);
    await waits.wakeAt({ workspaceId: "w", id: "t1" }, at, "tok");
    await waits.wakeOnSignal({ workspaceId: "w", id: "t1" }, "child");
    expect(jobs.jobs).toEqual([
      { name: JOBS.taskWake, data: { workspaceId: "w", taskId: "t1", signal: "timer", waitToken: "tok" }, opts: { runAt: at, group: "task:t1" } },
      { name: JOBS.taskWake, data: { workspaceId: "w", taskId: "t1", signal: "child" }, opts: { group: "task:t1" } },
    ]);
    await jobs.schedule(JOBS.runSweep, "* * * * *", {});
    expect(jobs.schedules).toEqual([{ name: JOBS.runSweep, cron: "* * * * *", data: {} }]);
  });

  it("domain/ no importa pg-boss", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(path.resolve(import.meta.dirname, "../src/domain"));
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => /from ["']pg-boss["']/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});

describe("E4 · política de riesgo por tenant", () => {
  it("solo endurece: read directo, send aprobación, delete nunca directo, write externo con aprobación", () => {
    const p = DEFAULT_RISK_POLICY;
    expect(applyRiskPolicy("NEVER", "read", "internal", p)).toBe("NEVER");
    expect(applyRiskPolicy("NEVER", "write", "internal", p)).toBe("NEVER");
    expect(applyRiskPolicy("NEVER", "write", "external", p)).toBe("ASK_OWNER");
    expect(applyRiskPolicy("NEVER", "write", "external", p, true)).toBe("NEVER"); // nativa de contacto (memoria, handoff)
    expect(applyRiskPolicy("NEVER", "send", "internal", p)).toBe("ASK_OWNER");
    expect(applyRiskPolicy("NEVER", "money", "internal", p)).toBe("ASK_OWNER");
    expect(applyRiskPolicy("NEVER", "delete", "internal", { ...p, send: "direct" })).toBe("ASK_OWNER");
    expect(applyRiskPolicy("ALWAYS", "read", "internal", p)).toBe("ALWAYS"); // ALWAYS de la tool gana
    expect(applyRiskPolicy("NEVER", "send", "internal", { send: "direct" })).toBe("NEVER");
    expect(applyRiskPolicy("NEVER", "read", "internal", { read: "approval" })).toBe("ASK_OWNER");
  });

  describe("API", () => {
    let ctx: AppContext;
    let app: FastifyInstance;
    beforeAll(async () => {
      ctx = testContext({ queue: new RecordingQueue() });
      await resetDb(ctx);
      app = await buildApp(ctx);
      await app.ready();
    });
    afterAll(async () => {
      await app.close();
      await closeContext(ctx);
    });

    async function signIn(email: string, workspaceId: string, role: "OWNER" | "ADMIN") {
      await createUserWithPassword(ctx.db, { email, name: email, password: "una-clave-larga-123", workspaceId, role });
      const res = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", payload: { email, password: "una-clave-larga-123" } });
      return { cookie: String(res.headers["set-cookie"]).split(";")[0]!, "x-workspace-id": workspaceId };
    }

    it("bajar send a directo exige un usuario OWNER y queda auditado; delete no se puede pasar a directo", async () => {
      const w = await seedWorkspace(ctx, `rp-${Date.now()}`);
      // Una API key (aunque tenga todos los scopes) no baja send.
      const byKey = await app.inject({ method: "PUT", url: "/v1/workspace/risk-policy", headers: w.auth, payload: { send: "direct" } });
      expect(byKey.statusCode).toBe(403);
      expect(byKey.json().error.code).toBe("owner_required");
      // Endurecer sí puede hacerlo un admin o una key.
      expect((await app.inject({ method: "PUT", url: "/v1/workspace/risk-policy", headers: w.auth, payload: { read: "approval" } })).statusCode).toBe(200);
      const admin = await signIn(`admin-${Date.now()}@x.com`, w.workspace.id, "ADMIN");
      expect((await app.inject({ method: "PUT", url: "/v1/workspace/risk-policy", headers: admin, payload: { send: "direct" } })).statusCode).toBe(403);
      const owner = await signIn(`owner-${Date.now()}@x.com`, w.workspace.id, "OWNER");
      expect((await app.inject({ method: "PUT", url: "/v1/workspace/risk-policy", headers: owner, payload: { send: "direct" } })).statusCode).toBe(200);
      const log = await ctx.db.auditLog.findFirstOrThrow({
        where: { workspaceId: w.workspace.id, action: "workspace.risk_policy.updated", data: { path: ["lowered"], array_contains: ["send"] } },
      });
      expect(log.actorType).toBe("user");
      expect((await app.inject({ method: "PUT", url: "/v1/workspace/risk-policy", headers: owner, payload: { delete: "direct" } })).statusCode).toBe(400);
      expect(
        (await app.inject({ method: "PUT", url: "/v1/workspace/risk-policy", headers: owner, payload: { write: { external: "direct" } } })).statusCode,
      ).toBe(400);
      const policies = await app.inject({ method: "GET", url: "/v1/workspace/policies", headers: owner });
      expect(policies.json().riskPolicy).toMatchObject({ send: "direct", delete: "approval" });
    });

    it("un OPERATOR no puede tocar políticas", async () => {
      const w = await seedWorkspace(ctx, `op-${Date.now()}`, ["tasks:read", "tasks:write"]);
      expect((await app.inject({ method: "PUT", url: "/v1/workspace/risk-policy", headers: w.auth, payload: { read: "approval" } })).statusCode).toBe(403);
    });
  });
});

describe("E7 · LLM con residencia en la UE", () => {
  const none: LlmPolicy = {};
  it("acepta Azure UE que demuestra la región, Mistral EU, eu_hosted listado y self_hosted interno", () => {
    expect(
      assertEuResidency(
        { kind: "llm.azure_openai", provider: "azure_openai", region: "swedencentral", url: "https://acme-swedencentral.openai.azure.com" },
        none,
      ),
    ).toMatchObject({ region: "swedencentral" });
    expect(
      assertEuResidency(
        { kind: "llm.azure_openai", provider: "azure_openai", region: "francecentral", url: "https://francecentral.api.cognitive.microsoft.com" },
        none,
      ),
    ).toBeTruthy();
    expect(assertEuResidency({ kind: "llm.mistral", provider: "mistral", region: "eu", url: "https://api.mistral.ai/v1" }, none)).toBeTruthy();
    expect(
      assertEuResidency({ kind: "llm.openai_compatible", provider: "eu_hosted", region: "de", url: "https://llm.acme.eu/v1" }, { hosts: ["llm.acme.eu"] }),
    ).toBeTruthy();
    expect(assertEuResidency({ kind: "llm.openai_compatible", provider: "self_hosted", region: "fsn1", url: "http://ollama:11434/v1" }, none)).toBeTruthy();
  });

  it("rechaza xAI, api.openai.com, regiones de fuera, hosts sin región demostrable y proveedores fuera de la política del tenant", () => {
    const bad =
      (c: Parameters<typeof assertEuResidency>[0], p: LlmPolicy = none) =>
      () =>
        assertEuResidency(c, p);
    expect(bad({ kind: "llm.openai_compatible", provider: "eu_hosted", region: "eu", url: "https://api.x.ai/v1" }, { hosts: ["api.x.ai"] })).toThrow(
      /no procesa en la UE/,
    );
    expect(bad({ kind: "llm.openai", url: "https://api.openai.com/v1" })).toThrow(/Proveedor/);
    expect(bad({ kind: "llm.azure_openai", provider: "azure_openai", region: "eastus", url: "https://acme-eastus.openai.azure.com" })).toThrow(
      /fuera de la UE/,
    );
    expect(bad({ kind: "llm.azure_openai", provider: "azure_openai", region: "swedencentral", url: "https://acme.openai.azure.com" })).toThrow(
      /no demuestra la región/,
    );
    expect(bad({ kind: "llm.openai_compatible", provider: "eu_hosted", region: "de", url: "https://llm.acme.eu/v1" })).toThrow(/lista UE del workspace/);
    expect(bad({ kind: "llm.openai_compatible", provider: "self_hosted", region: "es", url: "https://llm.example.com/v1" })).toThrow(/self_hosted/);
    expect(bad({ kind: "llm.mistral", provider: "mistral", region: "eu", url: "https://api.mistral.ai/v1" }, { allowed: ["azure_openai"] })).toThrow(
      /no permite/,
    );
  });

  describe("al guardar y al usar", () => {
    let ctx: AppContext;
    beforeAll(async () => {
      ctx = testContext({ queue: new RecordingQueue() });
      await resetDb(ctx);
    });
    afterAll(async () => closeContext(ctx));

    it("guardar una conexión fuera de la UE falla sin eco de la clave; una de prueba UE se guarda", async () => {
      const ws = await ctx.db.workspace.create({ data: { name: "eu", slug: `eu-${Date.now()}` } });
      const key = "sk-esta-clave-no-debe-salir";
      const err = await ctx.connections.create(ws.id, { kind: "llm.openai", name: "oa", secret: { apiKey: key } }, systemActor).catch((e: Error) => e);
      expect(err).toMatchObject({ code: "model_provider" });
      expect(JSON.stringify(err) + String((err as Error).message)).not.toContain(key);
      await expect(
        ctx.connections.create(
          ws.id,
          {
            kind: "llm.azure_openai",
            name: "az",
            config: { region: "swedencentral", endpoint: "https://acme-swedencentral.openai.azure.com" },
            secret: { apiKey: "azure-key-ficticia" },
          },
          systemActor,
        ),
      ).resolves.toMatchObject({ kind: "llm.azure_openai" });
      await expect(
        ctx.connections.create(ws.id, { kind: "llm.mistral", name: "mistral", secret: { apiKey: "mistral-key-ficticia" } }, systemActor),
      ).resolves.toBeTruthy();
      // La política del tenant achica la lista: lo que ya no cumple no se puede reactivar ni usar.
      await ctx.workspacePolicies.setLlmPolicy(ws.id, { allowed: ["azure_openai"] }, systemActor);
      const resolver = new ConnectionLlmResolver(ctx.db, ctx.secretKeys);
      await expect(resolver.resolve(ws.id, "mistral:mistral-medium-latest")).rejects.toMatchObject({ code: "model_provider" });
      await expect(resolver.resolve(ws.id, "az:gpt-4.1-mini")).resolves.toMatchObject({
        provider: "azure_openai",
        region: "swedencentral",
        modelId: "gpt-4.1-mini",
      });
      // El tenant no puede ampliar la lista con un proveedor de fuera.
      await expect(ctx.workspacePolicies.setLlmPolicy(ws.id, { allowed: ["xai"] }, systemActor)).rejects.toMatchObject({ code: "llm_policy_invalid" });
    });

    it("una tarea con un modelo que ya no cumple queda BLOCKED model_region con cero llamadas", async () => {
      const local = createContext(loadEnv(process.env), { queue: new RecordingQueue() }); // resolver real (por conexión)
      try {
        const ws = await local.db.workspace.create({ data: { name: "mr", slug: `mr-${Date.now()}` } });
        await local.connections.create(ws.id, { kind: "llm.mistral", name: "mistral", secret: { apiKey: "mistral-key-ficticia" } }, systemActor);
        const agent = await local.db.agent.create({ data: { workspaceId: ws.id, name: "A", instructions: "i", model: "mistral:mistral-medium-latest" } });
        await local.workspacePolicies.setLlmPolicy(ws.id, { allowed: ["self_hosted"] }, systemActor);
        let fetched = 0;
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
          fetched++;
          return realFetch(...args);
        }) as typeof fetch;
        try {
          const task = await local.tasks.create(ws.id, { agentId: agent.id, goal: "Algo" }, systemActor);
          const run = await local.db.run.findFirstOrThrow({ where: { taskId: task.id } });
          await local.runtime.execute(ws.id, run.id);
          expect(await local.db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
            status: "BLOCKED",
            blockedReason: "model_region",
            spentSteps: 0,
          });
          expect(fetched).toBe(0);
        } finally {
          globalThis.fetch = realFetch;
        }
      } finally {
        await closeContext(local);
      }
    });
  });
});

describe("E8 · los logs no llevan el ticket de SSE", () => {
  it("ni en las rutas /events ni en cualquier otra URL", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const local = createContext(loadEnv({ ...process.env, LOG_LEVEL: "info" }), { queue: new RecordingQueue(), log: createLogger("info", sink) });
    const app = await buildApp(local);
    try {
      await app.inject({ method: "GET", url: "/v1/tasks/00000000-0000-4000-8000-000000000000/events?ticket=SECRETO-TICKET-1" });
      await app.inject({ method: "GET", url: "/v1/no-existe?ticket=SECRETO-TICKET-2" });
      await app.inject({ method: "GET", url: "/health?ticket=SECRETO-TICKET-3" });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).toContain("/v1/no-existe?ticket=[redacted]"); // la URL se loguea, sin el valor
      expect(lines.join("\n")).not.toMatch(/SECRETO-TICKET/);
    } finally {
      await app.close();
      await closeContext(local);
    }
  });
});
