import type { ErrorKind } from "../../shared/errors.js";

/** Traducción de errores de dominio a HTTP: el único sitio que conoce códigos de estado. */
export const HTTP_STATUS: Record<ErrorKind, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

/** Errores propios del protocolo HTTP (idempotencia, etc.), que no son del dominio. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
