import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, getServerEnv, requireEnv, resetServerEnvForTests } from "./env";

const VALID_KEY = "service-role-key-for-tests-0123456789";

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvForTests();
});

describe("server environment (Phase 1 task 1)", () => {
  it("returns validated core values", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", VALID_KEY);
    expect(getServerEnv()).toEqual({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: VALID_KEY });
  });

  it("names every missing variable", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const error = (() => { try { getServerEnv(); } catch (e) { return e; } })() as EnvError;
    expect(error).toBeInstanceOf(EnvError);
    expect(error.message).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(error.message).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("never includes a value in the error", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not-a-url-but-a-secret-value");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "short-secret");
    expect(() => getServerEnv()).toThrow(EnvError);
    try { getServerEnv(); } catch (error) {
      expect(String(error)).not.toContain("not-a-url-but-a-secret-value");
      expect(String(error)).not.toContain("short-secret");
    }
  });

  it("caches a successful result", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", VALID_KEY);
    const first = getServerEnv();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(getServerEnv()).toBe(first);
  });

  it("validates feature variables only when asked", () => {
    vi.stubEnv("SHOPIFY_CLIENT_ID", "client");
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "");
    expect(() => requireEnv(["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"] as const)).toThrow(/SHOPIFY_CLIENT_SECRET is required/);
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "secret");
    expect(requireEnv(["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"] as const)).toEqual({ SHOPIFY_CLIENT_ID: "client", SHOPIFY_CLIENT_SECRET: "secret" });
  });
});
