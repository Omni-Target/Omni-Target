import * as Sentry from "@sentry/nextjs";

/**
 * Reports a failure from work no request is waiting on, such as after() tasks
 * and cron loops, which would otherwise reach only the logs. Events pass through
 * the scrubbing in sentry-options.ts.
 */
export function captureBackgroundFailure(job: string, error: unknown): void {
  Sentry.captureException(error, { tags: { job } });
}
