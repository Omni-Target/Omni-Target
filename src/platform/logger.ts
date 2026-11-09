import { scrubSentryEvent, scrubText } from "@/lib/observability/sentry-scrub";

/**
 * Structured JSON logging (Phase 1, task 1). One line per event, carrying the
 * request, workspace, shop or job it belongs to. Messages and context pass
 * through the same scrubbing as Sentry events, so tokens, emails and phone
 * numbers never reach the logs.
 */
type Level = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  workspaceId?: string;
  shopId?: string;
  job?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext, error?: unknown): void;
  error(message: string, context?: LogContext, error?: unknown): void;
  child(context: LogContext): Logger;
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: scrubText(error.message), stack: error.stack ? scrubText(error.stack) : undefined };
  }
  return { message: scrubText(String(error)) };
}

function emit(level: Level, message: string, context: LogContext, error?: unknown) {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  const record = scrubSentryEvent({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...context,
    ...(error === undefined ? {} : { error: serializeError(error) }),
  });
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(base: LogContext = {}): Logger {
  return {
    debug: (message, context = {}) => emit("debug", message, { ...base, ...context }),
    info: (message, context = {}) => emit("info", message, { ...base, ...context }),
    warn: (message, context = {}, error) => emit("warn", message, { ...base, ...context }, error),
    error: (message, context = {}, error) => emit("error", message, { ...base, ...context }, error),
    child: (context) => createLogger({ ...base, ...context }),
  };
}

export const logger = createLogger();
