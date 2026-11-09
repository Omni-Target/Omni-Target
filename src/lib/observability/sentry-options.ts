import type * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./sentry-scrub";

type SentryOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;

/**
 * Options shared by the browser, server and edge SDKs.
 *
 * With no NEXT_PUBLIC_SENTRY_DSN the SDK stays disabled, so tests and local
 * runs send nothing. Every data category below defaults to on in the SDK; each
 * is switched off because merchant data must not leave through error reports.
 */
export const sharedSentryOptions = {
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Set NEXT_PUBLIC_SENTRY_ENVIRONMENT=staging on the staging deployment: Vercel
  // labels it "preview", which would mix it with every other preview build.
  environment:
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ||
    process.env.NEXT_PUBLIC_VERCEL_ENV ||
    process.env.VERCEL_ENV ||
    process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 0 : 0.05,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    mcp: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    stackFrameVariables: false,
  },
  beforeSend: (event) => scrubSentryEvent(event),
  beforeSendTransaction: (event) => scrubSentryEvent(event),
  beforeBreadcrumb: (breadcrumb) => scrubSentryEvent(breadcrumb),
} satisfies SentryOptions;
