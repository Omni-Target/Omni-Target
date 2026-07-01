/**
 * Minimal structured logger with sensitive-value redaction.
 *
 * Replaces scattered `console.*` calls. It keeps a console transport (works in
 * Vercel/serverless without extra deps) but namespaces every message by scope
 * and recursively redacts known-sensitive keys (tokens, secrets, keys) so they
 * can never leak into logs. `debug` is suppressed in production to cut noise.
 */
type LogLevel = "debug" | "info" | "warn" | "error";

const SENSITIVE_KEY =
  /(token|secret|password|authorization|api[_-]?key|access[_-]?key|client[_-]?secret)/i;

function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 4) return "[Truncated]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[Redacted]" : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, scope: string, message: string, meta?: unknown) {
  if (level === "debug" && process.env.NODE_ENV === "production") return;
  const line = `[${scope}] ${message}`;
  const fn = level === "debug" ? console.log : console[level];
  if (meta === undefined) fn(line);
  else fn(line, redact(meta));
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** Create a scoped logger, e.g. `const log = createLogger("dashboard-stats")`. */
export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit("debug", scope, m, meta),
    info: (m, meta) => emit("info", scope, m, meta),
    warn: (m, meta) => emit("warn", scope, m, meta),
    error: (m, meta) => emit("error", scope, m, meta),
  };
}
