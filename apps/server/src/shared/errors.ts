/**
 * Errores de dominio: describen QUÉ falló (tipo + código estable), no CÓMO se transporta.
 * La capa de acceso traduce el tipo a HTTP (access/http/errors.ts); un worker lo registra en el run.
 */
export type ErrorKind = "invalid" | "unauthorized" | "forbidden" | "not_found" | "conflict";

export class DomainError extends Error {
  constructor(
    readonly kind: ErrorKind,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const notFound = (what = "Recurso") => new DomainError("not_found", "not_found", `${what} no encontrado`);
export const unauthorized = (msg = "Credenciales ausentes o inválidas") => new DomainError("unauthorized", "unauthorized", msg);
export const forbidden = (msg = "Permisos insuficientes") => new DomainError("forbidden", "forbidden", msg);
export const conflict = (code: string, msg: string) => new DomainError("conflict", code, msg);
export const invalid = (code: string, msg: string, details?: unknown) => new DomainError("invalid", code, msg, details);
