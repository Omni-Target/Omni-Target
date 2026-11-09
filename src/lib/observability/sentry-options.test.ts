import { afterEach, describe, expect, it, vi } from "vitest";

const load = async () => {
  vi.resetModules();
  return (await import("./sentry-options")).sharedSentryOptions;
};

afterEach(() => vi.unstubAllEnvs());

describe("Sentry environment and sampling (OPS-02)", () => {
  it("keeps staging apart from other preview builds when told to", async () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "preview");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", "staging");
    expect((await load()).environment).toBe("staging");
  });

  it("falls back to the Vercel environment", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_ENVIRONMENT", "");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    expect((await load()).environment).toBe("production");
  });

  it("sends no traces from development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect((await load()).tracesSampleRate).toBe(0);
  });

  it("samples deployed traffic at 5%", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await load()).tracesSampleRate).toBe(0.05);
  });
});
