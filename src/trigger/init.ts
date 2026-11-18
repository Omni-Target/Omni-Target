import * as Sentry from "@sentry/node";
import { tasks } from "@trigger.dev/sdk";
import { sharedSentryOptions } from "@/lib/observability/sentry-options";

/**
 * Worker-wide setup, loaded by Trigger.dev before any task (src/trigger/init.ts).
 *
 * Sentry uses the app's options: no request data, no payloads, and the same
 * scrubbing. Default integrations stay off so Sentry does not instrument the
 * worker alongside Trigger.dev's own tracing. Without a DSN nothing is sent.
 */
Sentry.init({ ...sharedSentryOptions, defaultIntegrations: false });

/** A run that failed for good (no retry left): the task, run and attempt, never the payload. */
tasks.onFailure(async ({ error, ctx, task }) => {
  Sentry.captureException(error, {
    tags: { job: task, trigger_environment: ctx.environment.type },
    extra: { run_id: ctx.run.id, attempt: ctx.attempt.number },
  });
  await Sentry.flush(2_000);
});
