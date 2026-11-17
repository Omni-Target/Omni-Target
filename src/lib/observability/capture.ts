import * as Sentry from "@sentry/nextjs";

/**
 * Reports a failure from work no request is waiting on, such as after() tasks
 * and cron loops, which would otherwise reach only the logs. Events pass through
 * the scrubbing in sentry-options.ts.
 */
export function captureBackgroundFailure(job: string, error: unknown): void {
  Sentry.captureException(error, { tags: { job } });
}

/** Reports a condition that needs attention but is not an error in the code, such as a database nearing its quota. */
export function captureOperationalAlert(job: string, message: string, level: "warning" | "error", context: Record<string, unknown>): void {
  Sentry.captureMessage(message, { level, tags: { job }, extra: context });
}
