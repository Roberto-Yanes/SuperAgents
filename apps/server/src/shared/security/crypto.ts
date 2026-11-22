import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Prefijo del formato v2 (con AAD). Sin prefijo = formato v1 heredado. */
const MAGIC_V2 = Buffer.from("EGA2", "ascii");

/**
 * Cifra un objeto JSON con AES-256-GCM.
 * - v2 (con aad): "EGA2" | nonce(12) | tag(16) | ciphertext, autenticando `aad` (p. ej. "connection:<id>"):
 *   un secreto copiado a otra fila no descifra (L4).
 * - v1 (sin aad, heredado): nonce(12) | tag(16) | ciphertext.
 */
export function encryptJson(data: unknown, key: Buffer, aad?: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([...(aad ? [MAGIC_V2] : []), nonce, cipher.getAuthTag(), ciphertext]);
}

export function isV2(blob: Uint8Array): boolean {
  return Buffer.from(blob).subarray(0, MAGIC_V2.length).equals(MAGIC_V2);
}

/**
 * Descifra probando cada clave (actual primero, luego la antigua para rotación).
 * Un blob v2 exige el mismo `aad` con el que se cifró; un blob v1 se acepta (migración: CLI rotate-secrets).
 */
export function decryptJson<T = unknown>(blob: Uint8Array, keys: Buffer[], aad?: string): T {
  if (isV2(blob)) {
    if (!aad) throw new Error("Secreto v2 sin contexto (aad) para descifrarlo");
    return decryptRaw<T>(Buffer.from(blob).subarray(MAGIC_V2.length), keys, aad);
  }
  return decryptRaw<T>(Buffer.from(blob), keys);
}

function decryptRaw<T>(buf: Buffer, keys: Buffer[], aad?: string): T {
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(NONCE_BYTES + TAG_BYTES);
  for (const key of keys) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as T;
    } catch {
      // probar la siguiente clave
    }
  }
  throw new Error("No se pudo descifrar el secreto con ninguna clave configurada");
}

/** Prefijo de los binarios cifrados (archivos). */
const MAGIC_BIN = Buffer.from("EGAB", "ascii");

/** Cifra bytes con AES-256-GCM y AAD obligatorio: "EGAB" | nonce(12) | tag(16) | ciphertext. */
export function encryptBytes(data: Buffer, key: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC_BIN, nonce, cipher.getAuthTag(), ciphertext]);
}

/** Descifra bytes probando cada clave. Falla si el contenido o el AAD no coinciden. */
export function decryptBytes(blob: Buffer, keys: Buffer[], aad: string): Buffer {
  if (!blob.subarray(0, MAGIC_BIN.length).equals(MAGIC_BIN)) throw new Error("Formato de archivo cifrado desconocido");
  const buf = blob.subarray(MAGIC_BIN.length);
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(NONCE_BYTES + TAG_BYTES);
  for (const key of keys) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      // probar la siguiente clave
    }
  }
  throw new Error("No se pudo descifrar el archivo con ninguna clave configurada");
}

export function sha256Bytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** JSON con claves ordenadas: base de hashes de idempotencia. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
