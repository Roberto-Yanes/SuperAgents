import { mkdtemp, readdir, readFile, rm, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/access/http/app.js";
import { closeContext, type AppContext } from "../src/container.js";
import { systemActor } from "../src/data/audit.js";
import { FileService, reencryptAllFiles } from "../src/domain/files/service.js";
import { LocalBlobStore } from "../src/data/blob-store.js";
import { chunkText, fuse, type Embedder } from "../src/domain/knowledge/service.js";
import { knowledgeTools } from "../src/integrations/tools/builtin/knowledge.js";
import { StaticEmbedderResolver } from "../src/orchestration/llm/embeddings.js";
import { buildSystemPrompt } from "../src/orchestration/runtime/prompt.js";
import { RecordingQueue, resetDb, seedWorkspace, testContext } from "./helpers.js";

/** Archivos cifrados (vault de datos) y base de conocimiento (E6, RAG). */

/** Embebedor falso y determinista: bolsa de palabras con hash en 64 dimensiones. */
const fakeEmbedder: Embedder = {
  model: "fake:bow-64",
  embed: async (texts) =>
    texts.map((t) => {
      const v = new Array<number>(64).fill(0);
      for (const w of t
        .toLowerCase()
        .normalize("NFD")
        .replace(/[^a-z\s]/g, "")
        .split(/\s+/)
        .filter((x) => x.length > 3)) {
        let h = 0;
        for (const ch of w.slice(0, 6)) h = (h * 31 + ch.charCodeAt(0)) % 64;
        v[h]! += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    }),
};

let ctx: AppContext;
let app: FastifyInstance;
let queue: RecordingQueue;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "ega-files-"));
  process.env.DATA_DIR = dataDir;
  queue = new RecordingQueue();
  ctx = testContext({ queue, embedders: new StaticEmbedderResolver(null) });
  delete process.env.DATA_DIR;
  await resetDb(ctx);
  app = await buildApp(ctx);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closeContext(ctx);
  await rm(dataDir, { recursive: true, force: true });
});

describe("Archivos cifrados", () => {
  it("sube, guarda cifrado en disco, descarga igual y aísla por workspace", async () => {
    const w = await seedWorkspace(ctx, `f-${Date.now()}`);
    const other = await seedWorkspace(ctx, `f2-${Date.now()}`);
    const body = "Tarifas 2026: limpieza dental 45 €, blanqueamiento 180 €. Dato privado: DNI 12345678Z";
    const up = await app.inject({ method: "POST", url: "/v1/files?name=tarifas.txt", headers: { ...w.auth, "content-type": "text/plain" }, payload: body });
    expect(up.statusCode).toBe(201);
    const file = up.json();
    expect(file).toMatchObject({ name: "tarifas.txt", mimeType: "text/plain", size: Buffer.byteLength(body) });

    const onDisk = path.join(dataDir, "files", w.workspace.id, file.id);
    const raw = await readFile(onDisk);
    expect(raw.subarray(0, 4).toString()).toBe("EGAB");
    expect(raw.toString("latin1")).not.toContain("12345678Z");

    const down = await app.inject({ method: "GET", url: `/v1/files/${file.id}/content`, headers: w.auth });
    expect(down.statusCode).toBe(200);
    expect(down.body).toBe(body);
    expect(down.headers["content-type"]).toContain("text/plain");
    expect((await app.inject({ method: "GET", url: `/v1/files/${file.id}/content`, headers: other.auth })).statusCode).toBe(404);

    // JSON también llega crudo (no lo interpreta el parser global).
    const json = await app.inject({
      method: "POST",
      url: "/v1/files?name=datos.json",
      headers: { ...w.auth, "content-type": "application/json" },
      payload: '{"a":1}',
    });
    expect(json.statusCode).toBe(201);

    // Un blob copiado sobre otro archivo no descifra (AAD por archivo).
    await copyFile(onDisk, path.join(dataDir, "files", w.workspace.id, json.json().id));
    expect((await app.inject({ method: "GET", url: `/v1/files/${json.json().id}/content`, headers: w.auth })).statusCode).toBe(500);

    const del = await app.inject({ method: "DELETE", url: `/v1/files/${file.id}`, headers: w.auth });
    expect(del.statusCode).toBe(204);
    expect(await readdir(path.join(dataDir, "files", w.workspace.id))).not.toContain(file.id);
  });

  it("rotación de SECRET_KEY: recifra los archivos y después basta la clave nueva", async () => {
    const w = await seedWorkspace(ctx, `f4-${Date.now()}`);
    const store = new LocalBlobStore(path.join(dataDir, "rot"));
    const oldKey = Buffer.alloc(32, 1);
    const newKey = Buffer.alloc(32, 2);
    const before = new FileService({ db: ctx.db, store, keys: [oldKey] });
    const f = await before.upload(w.workspace.id, { name: "a.txt", mimeType: "text/plain", data: Buffer.from("secreto") }, systemActor);
    const r = await reencryptAllFiles(ctx.db, store, [newKey, oldKey]);
    expect(r.rewritten).toBeGreaterThanOrEqual(1);
    const after = new FileService({ db: ctx.db, store, keys: [newKey] });
    expect((await after.read(w.workspace.id, f.id)).data.toString()).toBe("secreto");
    await expect(before.read(w.workspace.id, f.id)).rejects.toThrow();
  });

  it("rechaza archivos vacíos y nombres con rutas", async () => {
    const w = await seedWorkspace(ctx, `f3-${Date.now()}`);
    expect(
      (await app.inject({ method: "POST", url: "/v1/files?name=x.txt", headers: { ...w.auth, "content-type": "text/plain" }, payload: "" })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/v1/files?name=../../etc/passwd", headers: { ...w.auth, "content-type": "text/plain" }, payload: "x" }))
        .statusCode,
    ).toBe(400);
  });
});

describe("Base de conocimiento (E6)", () => {
  const faq = [
    "# Clínica Sol",
    "Horario: de lunes a viernes de 9:00 a 20:00. Los sábados abrimos de 10:00 a 14:00.",
    "Precios: la limpieza dental cuesta 45 euros. El blanqueamiento cuesta 180 euros y la ortodoncia invisible desde 2.500 euros.",
    "Aparcamiento gratuito para pacientes en el parking de la calle Mayor.",
  ].join("\n\n");

  it("trocea, busca por texto completo en español y no ve otro workspace", async () => {
    const w = await seedWorkspace(ctx, `k-${Date.now()}`);
    const other = await seedWorkspace(ctx, `k2-${Date.now()}`);
    const res = await app.inject({ method: "POST", url: "/v1/knowledge/documents", headers: w.auth, payload: { title: "FAQ", text: faq } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "READY", chunkCount: 1 });
    expect(queue.jobs.filter((j) => j.name === "knowledge.ingest")).toHaveLength(0); // sin modelo de embeddings: nada que encolar

    const hits = (await app.inject({ method: "POST", url: "/v1/knowledge/search", headers: w.auth, payload: { query: "¿Cuánto cuesta una limpieza?" } })).json()
      .data;
    expect(hits[0].content).toContain("45 euros");
    expect((await app.inject({ method: "POST", url: "/v1/knowledge/search", headers: other.auth, payload: { query: "limpieza" } })).json().data).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/v1/knowledge/search", headers: w.auth, payload: { query: "de la el" } })).json().data).toEqual([]);
  });

  it("desde un archivo de texto subido; los tipos no textuales se rechazan", async () => {
    const w = await seedWorkspace(ctx, `k3-${Date.now()}`);
    const md = await ctx.files.upload(
      w.workspace.id,
      { name: "servicios.md", mimeType: "text/markdown", data: Buffer.from("## Servicios\n\nImplantes dentales con garantía de 10 años.") },
      systemActor,
    );
    const png = await ctx.files.upload(w.workspace.id, { name: "logo.png", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, systemActor);
    expect(
      (await app.inject({ method: "POST", url: "/v1/knowledge/documents", headers: w.auth, payload: { title: "Servicios", fileId: md.id } })).statusCode,
    ).toBe(201);
    expect((await app.inject({ method: "POST", url: "/v1/knowledge/documents", headers: w.auth, payload: { title: "Logo", fileId: png.id } })).statusCode).toBe(
      400,
    );
    const hits = await ctx.knowledge.search(w.workspace.id, "garantía de los implantes");
    expect(hits[0]?.title).toBe("Servicios");
  });

  it("con modelo de embeddings: encola, embebe una vez y la búsqueda combina texto y vector", async () => {
    const local = testContext({ queue: new RecordingQueue(), embedders: new StaticEmbedderResolver(fakeEmbedder) });
    try {
      const ws = await local.db.workspace.create({ data: { name: "v", slug: `v-${Date.now()}` } });
      const doc = await local.knowledge.create(ws.id, { title: "FAQ", text: Array.from({ length: 6 }, () => faq).join("\n\n") }, systemActor);
      expect(doc.chunkCount).toBeGreaterThan(1);
      expect(await local.knowledge.embedDocument(ws.id, doc.id)).toBe(doc.chunkCount);
      expect(await local.knowledge.embedDocument(ws.id, doc.id)).toBe(0); // idempotente
      const hits = await local.knowledge.search(ws.id, "parking gratuito para pacientes");
      expect(hits[0]?.content).toContain("parking");
      // Solo semántico (sin palabras en común exactas): lo encuentra el vector.
      const semantic = await local.knowledge.search(ws.id, "aparcamiento pacientes");
      expect(semantic.length).toBeGreaterThan(0);
    } finally {
      await closeContext(local);
    }
  });

  it("kb.search: solo lee el workspace del run, también en la cara externa", async () => {
    const w = await seedWorkspace(ctx, `k4-${Date.now()}`);
    await ctx.knowledge.create(w.workspace.id, { title: "FAQ", text: faq }, systemActor);
    const [tool] = knowledgeTools(ctx.knowledge);
    expect(tool).toMatchObject({ name: "kb.search", risk: "read", exposure: "external" });
    const base = {
      agentId: crypto.randomUUID(),
      runId: "r",
      conversationId: null,
      contactId: null,
      idempotencyKey: "k",
      task: null,
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log,
      face: "external" as const,
    };
    const mine = await tool!.execute({ query: "horario sábados" }, { ...base, workspaceId: w.workspace.id });
    expect(JSON.stringify(mine)).toContain("10:00 a 14:00");
    const foreign = await tool!.execute({ query: "horario sábados" }, { ...base, workspaceId: crypto.randomUUID() });
    expect(foreign).toMatchObject({ ok: true, results: [] });
  });

  it("utilidades: trozos con solape y fusión de rangos", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Párrafo ${i} ${"x".repeat(80)}`).join("\n\n");
    const chunks = chunkText(text, 400, 50);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 400)).toBe(true);
    expect(chunks.join(" ")).toContain("Párrafo 29");
    const a = { chunkId: "a", documentId: "d", title: "t", content: "", score: 1 };
    const b = { ...a, chunkId: "b" };
    expect(fuse([[a, b], [b]], 2).map((h) => h.chunkId)).toEqual(["b", "a"]);
  });
});

describe("Memoria en tres capas (E6)", () => {
  it("las notas del agente entran en la cara interna y nunca en la externa", () => {
    const base = {
      agentName: "A",
      instructions: "i",
      timezone: "Europe/Madrid",
      now: new Date(),
      memories: [],
      notes: [{ key: "pendiente", content: "Revisar tarifas de 2027" }],
    };
    expect(buildSystemPrompt({ ...base, face: "internal" })).toContain("Revisar tarifas de 2027");
    expect(buildSystemPrompt({ ...base, face: "external" })).not.toContain("Revisar tarifas de 2027");
  });
});
