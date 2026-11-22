import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/access/http/app.js";
import { loadEnv } from "../src/shared/config/env.js";
import { closeContext, createContext, type AppContext } from "../src/container.js";
import { systemActor } from "../src/data/audit.js";
import { reencryptAllSecrets } from "../src/domain/connections/service.js";
import { memoryRecall, memorySave } from "../src/integrations/tools/builtin/index.js";
import { decryptJson, encryptJson, isV2 } from "../src/shared/security/crypto.js";
import { assertAllowedBaseUrl } from "../src/shared/security/url-policy.js";
import { RecordingQueue, resetDb, testContext } from "./helpers.js";

/** Regresiones de la revisión (hallazgos bajos): L3, L4, L5, L7, L8. */
let ctx: AppContext;
beforeAll(async () => {
  ctx = testContext();
  await resetDb(ctx);
});
afterAll(async () => closeContext(ctx));

describe("L3/L7 · rate limit", () => {
  it("ni prefijos de API key inventados ni X-Forwarded-For falso esquivan el límite por IP", async () => {
    const local = createContext(loadEnv({ ...process.env, RATE_LIMIT_MAX: "3", TRUST_PROXY: "0" }), { queue: new RecordingQueue() });
    const app = await buildApp(local);
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({
          method: "GET",
          url: "/v1/agents",
          headers: { authorization: `Bearer ega_fake${i}xxxxxxx_secret`, "x-forwarded-for": `10.0.0.${i}` },
        });
        codes.push(r.statusCode);
      }
      expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
      expect(codes.slice(3)).toEqual([429, 429]);
    } finally {
      await app.close();
      await closeContext(local);
    }
  });
});

describe("L4 · secretos ligados a su fila (AAD)", () => {
  const key = Buffer.alloc(32, 7);
  it("v2 exige el mismo contexto; v1 sigue legible", () => {
    const v2 = encryptJson({ apiKey: "sk" }, key, "connection:a");
    expect(isV2(v2)).toBe(true);
    expect(decryptJson(v2, [key], "connection:a")).toEqual({ apiKey: "sk" });
    expect(() => decryptJson(v2, [key], "connection:b")).toThrow();
    expect(() => decryptJson(v2, [key])).toThrow();
    const v1 = encryptJson({ apiKey: "old" }, key);
    expect(decryptJson(v1, [key], "connection:a")).toEqual({ apiKey: "old" });
  });

  it("un secreto copiado a otra conexión no descifra; rotate-secrets migra v1 y la clave antigua", async () => {
    const ws = await ctx.db.workspace.create({ data: { name: "l4", slug: "l4" } });
    const a = await ctx.connections.create(ws.id, { kind: "llm.mistral", name: "a", secret: { apiKey: "sk-aaaaaaaaaaaa" } }, systemActor);
    const b = await ctx.connections.create(ws.id, { kind: "llm.mistral", name: "b", secret: { apiKey: "sk-bbbbbbbbbbbb" } }, systemActor);
    const rowA = await ctx.db.connection.findUniqueOrThrow({ where: { id: a.id } });
    expect(isV2(rowA.secretEnc!)).toBe(true);
    await ctx.db.connection.update({ where: { id: b.id }, data: { secretEnc: rowA.secretEnc } }); // copia maliciosa
    const rowB = await ctx.db.connection.findUniqueOrThrow({ where: { id: b.id } });
    expect(() => ctx.connections.readSecret(rowB)).toThrow();

    const oldKey = Buffer.alloc(32, 9);
    await ctx.db.connection.update({ where: { id: b.id }, data: { secretEnc: new Uint8Array(encryptJson({ apiKey: "sk-legacy" }, oldKey)) } });
    expect(await reencryptAllSecrets(ctx.db, [...ctx.secretKeys, oldKey])).toMatchObject({ rewritten: 2 });
    const migrated = await ctx.db.connection.findUniqueOrThrow({ where: { id: b.id } });
    expect(isV2(migrated.secretEnc!)).toBe(true);
    expect(ctx.connections.readSecret(migrated)).toEqual({ apiKey: "sk-legacy" });
  });
});

describe("L5 · baseURL de LLM", () => {
  it("bloquea metadatos y link-local; respeta la allowlist", async () => {
    expect(() => assertAllowedBaseUrl("http://169.254.169.254/latest")).toThrow();
    expect(() => assertAllowedBaseUrl("http://metadata.google.internal/v1")).toThrow();
    expect(() => assertAllowedBaseUrl("http://[fe80::1]:8080")).toThrow();
    expect(() => assertAllowedBaseUrl("file:///etc/passwd")).toThrow();
    expect(() => assertAllowedBaseUrl("http://ollama:11434/v1")).not.toThrow();
    expect(() => assertAllowedBaseUrl("https://evil.example.com/v1", ["ollama"])).toThrow();
    const ws = await ctx.db.workspace.create({ data: { name: "l5", slug: "l5" } });
    await expect(
      ctx.connections.create(
        ws.id,
        {
          kind: "llm.openai_compatible",
          name: "x",
          config: { baseURL: "http://169.254.169.254/v1", provider: "self_hosted", region: "es" },
          secret: { apiKey: "k-1234567890" },
        },
        systemActor,
      ),
    ).rejects.toMatchObject({ code: "base_url_blocked" });
  });
});

describe("L8 · memorias", () => {
  it("desde la cara externa sin contacto no se leen ni escriben notas de equipo", async () => {
    const base = {
      workspaceId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      runId: "r",
      conversationId: null,
      contactId: null,
      idempotencyKey: "k",
      task: null,
      db: ctx.db,
      bus: ctx.bus,
      log: ctx.log,
    };
    expect(await memorySave.execute({ key: "k", content: "c" }, { ...base, face: "external" })).toMatchObject({ ok: false });
    expect(await memoryRecall.execute({}, { ...base, face: "external" })).toMatchObject({ ok: false });
  });
});

describe("M10 · sesión de Baileys cifrada en disco", () => {
  it("guarda credenciales y claves cifradas, migra ficheros en claro y detecta manipulación", async () => {
    const { mkdtemp, readdir, readFile, writeFile, rm, rename } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { BufferJSON } = await import("baileys");
    const { useEncryptedFileAuthState } = await import("../src/integrations/channels/baileys-auth-state.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "ega-m10-"));
    const keys = [Buffer.alloc(32, 3)];
    try {
      // Fichero heredado en claro (useMultiFileAuthState)
      await writeFile(path.join(dir, "pre-key-1.json"), JSON.stringify({ public: Buffer.from("pub"), private: Buffer.from("priv") }, BufferJSON.replacer));
      const a = await useEncryptedFileAuthState(dir, { keys, connectionId: "conn-1" });
      await a.saveCreds();
      await a.state.keys.set({ "sender-key": { "g1::u1": Buffer.from("secreto-de-grupo") } });

      const files = await readdir(dir);
      expect(files.every((f) => f.endsWith(".enc"))).toBe(true); // nada en claro
      for (const f of files) expect((await readFile(path.join(dir, f))).toString("latin1")).not.toContain("secreto");

      const b = await useEncryptedFileAuthState(dir, { keys, connectionId: "conn-1" });
      expect(b.state.creds.registrationId).toBe(a.state.creds.registrationId);
      expect(await b.state.keys.get("pre-key", ["1"])).toEqual({ "1": { public: Buffer.from("pub"), private: Buffer.from("priv") } });
      expect(await b.state.keys.get("sender-key", ["g1::u1"])).toEqual({ "g1::u1": Buffer.from("secreto-de-grupo") });

      // Otra conexión (otro AAD) u otra clave no descifran; un fichero renombrado tampoco.
      await expect(useEncryptedFileAuthState(dir, { keys, connectionId: "conn-2" })).rejects.toThrow();
      await expect(useEncryptedFileAuthState(dir, { keys: [Buffer.alloc(32, 4)], connectionId: "conn-1" })).rejects.toThrow();
      await rename(path.join(dir, "pre-key-1.json.enc"), path.join(dir, "pre-key-2.json.enc"));
      await expect(b.state.keys.get("pre-key", ["2"])).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
