import { describe, expect, it } from "vitest";
import { effectiveApproval, ToolRegistry, fromModelToolName, toModelToolName } from "../src/integrations/tools/registry.js";
import { canonicalJson, decryptJson, encryptJson } from "../src/shared/security/crypto.js";
import { assertWhatsappWindow } from "../src/integrations/channels/adapter.js";
import { builtinTools } from "../src/integrations/tools/builtin/index.js";

describe("modo de aprobación efectivo", () => {
  it.each([
    ["NEVER", undefined, "NEVER"],
    ["ASK_OWNER", undefined, "ASK_OWNER"],
    ["ASK_OWNER", "NEVER", "NEVER"], // el dueño confía: se relaja
    ["ALWAYS", "NEVER", "ALWAYS"], // ALWAYS nunca se relaja
    ["ALWAYS", "ASK_OWNER", "ALWAYS"],
    ["NEVER", "ASK_OWNER", "ASK_OWNER"], // endurecer siempre se puede
    ["NEVER", "ALWAYS", "ALWAYS"],
  ] as const)("%s + override %s → %s", (base, override, expected) => {
    expect(effectiveApproval(base, override)).toBe(expected);
  });

  it("un agente solo ve las tools habilitadas", async () => {
    const reg = new ToolRegistry();
    for (const t of builtinTools) reg.register(t);
    const visible = await reg.resolveForAgent("ws", { tools: ["memory.save", "no.existe"] });
    expect(visible.map((v) => v.def.name)).toEqual(["memory.save"]);
  });

  it("nombres de tool compatibles con proveedores", () => {
    expect(toModelToolName("memory.save")).toBe("memory__save");
    expect(fromModelToolName("memory__save")).toBe("memory.save");
  });
});

describe("cifrado de secretos", () => {
  const k1 = Buffer.alloc(32, 1);
  const k2 = Buffer.alloc(32, 2);
  it("cifra y descifra; soporta rotación de clave", () => {
    const blob = encryptJson({ apiKey: "sk-123" }, k1);
    expect(decryptJson(blob, [k1])).toEqual({ apiKey: "sk-123" });
    expect(decryptJson(blob, [k2, k1])).toEqual({ apiKey: "sk-123" });
    expect(() => decryptJson(blob, [k2])).toThrow();
    expect(blob.toString("utf8")).not.toContain("sk-123");
  });
  it("JSON canónico independiente del orden de claves", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("ventana de 24 h de WhatsApp", () => {
  it("permite dentro y bloquea fuera", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    expect(() => assertWhatsappWindow({ lastInboundAt: new Date("2026-11-21T00:00:00Z") }, now)).not.toThrow();
    expect(() => assertWhatsappWindow({ lastInboundAt: new Date("2026-11-19T00:00:00Z") }, now)).toThrow(/24 h/);
    expect(() => assertWhatsappWindow({ lastInboundAt: null }, now)).toThrow();
  });
});
