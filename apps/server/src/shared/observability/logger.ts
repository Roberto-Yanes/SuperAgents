import { pino, type Logger } from "pino";

/** Campos que nunca deben salir en logs. */
const REDACT = ["req.headers.authorization", "req.headers.cookie", "req.query.ticket", "*.password", "*.apiKey", "*.secret", "*.token", "*.secretEnc"];

/** Quita de una URL los parámetros que son credenciales (ticket de SSE/WS). */
export function stripSecretsFromUrl(url: unknown): unknown {
  return typeof url === "string" ? url.replace(/([?&](?:ticket|token|access_token)=)[^&#]*/gi, "$1[redacted]") : url;
}

/**
 * Logger de la aplicación. ADR 005: sin prompts, sin claves y sin ticket de SSE (también en la URL de la petición).
 * `destination` permite capturar los logs en tests.
 */
export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    level,
    redact: { paths: REDACT, censor: "[redacted]" },
    base: { service: "ega-server" },
    serializers: {
      req: (req: Record<string, unknown>) => ({ ...pino.stdSerializers.req(req as never), url: stripSecretsFromUrl((req as { url?: unknown }).url) }),
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
