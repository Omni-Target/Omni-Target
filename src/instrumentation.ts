import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");

    try {
      const dns = await import("node:dns");
      dns.setDefaultResultOrder("ipv4first");
    } catch {}

    try {
      const { Agent, setGlobalDispatcher } = await import("undici");
      setGlobalDispatcher(
        new Agent({
          connect: {
            family: 4,
          },
        })
      );
    } catch (e) {
      console.error("Failed to set undici global dispatcher in instrumentation:", e);
    }
  }
}

// Captures errors from Server Components, route handlers and the proxy.
export const onRequestError = Sentry.captureRequestError;
