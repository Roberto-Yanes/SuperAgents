import { pino, type Logger } from "pino";

/** Campos que nunca deben salir en logs. */
const REDACT = ["req.headers.authorization", "req.headers.cookie", "*.password", "*.apiKey", "*.secret", "*.token", "*.secretEnc"];

export function createLogger(level: string): Logger {
  return pino({ level, redact: { paths: REDACT, censor: "[redacted]" }, base: { service: "ega-server" } });
}
