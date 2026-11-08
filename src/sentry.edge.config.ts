import * as Sentry from "@sentry/nextjs";
import { sharedSentryOptions } from "@/lib/observability/sentry-options";

Sentry.init(sharedSentryOptions);
