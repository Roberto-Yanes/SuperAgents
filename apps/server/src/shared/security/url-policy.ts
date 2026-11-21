import { isIP } from "node:net";
import { invalid } from "../errors.js";

/** Destinos que nunca deben recibir peticiones salientes configurables (metadatos de nube, link-local). */
const ALWAYS_BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data"]);

function isLinkLocalOrMetadata(host: string): boolean {
  if (ALWAYS_BLOCKED_HOSTS.has(host)) return true;
  if (isIP(host) === 4) return host.startsWith("169.254.") || host === "100.100.100.200"; // AWS/GCP/Azure, Alibaba
  if (isIP(host) === 6) return host.toLowerCase().startsWith("fe80:") || host === "fd00:ec2::254";
  return false;
}

/**
 * Política de URLs base configurables por un admin del workspace (p. ej. baseURL de un LLM compatible) (L5):
 * - solo http/https;
 * - nunca metadatos de nube ni link-local (SSRF hacia credenciales del host);
 * - si LLM_BASEURL_ALLOWLIST está definida, el host debe estar en ella (p. ej. "ollama,api.mistral.ai").
 */
export function assertAllowedBaseUrl(raw: string, allowlist: string[] = []): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("base_url_invalid", "baseURL no es una URL válida");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid("base_url_invalid", "baseURL debe ser http(s)");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLinkLocalOrMetadata(host)) throw invalid("base_url_blocked", "baseURL apunta a una dirección no permitida");
  if (allowlist.length > 0 && !allowlist.includes(host)) throw invalid("base_url_not_allowed", `El host ${host} no está en LLM_BASEURL_ALLOWLIST`);
}

export function parseAllowlist(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
