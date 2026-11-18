import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  trigger: vi.fn(),
  createKey: vi.fn(async (key: string) => `idem:${key}`),
}));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: sdk.trigger }, idempotencyKeys: { create: sdk.createKey } }));

import { shopAccessCheckPayload } from "./payloads";
import { enqueueShopAccessCheck, TRIGGER_TIMEOUT_MS } from "./trigger";

const payload = { shopDomain: "omni-dev.myshopify.com", reason: "install" } as const;

beforeEach(() => {
  vi.stubEnv("TRIGGER_SECRET_KEY", "tr_dev_test");
  sdk.trigger.mockReset();
  sdk.createKey.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("triggering from Next.js (Phase 2 task 3)", () => {
  it("queues the check once per shop and reason, one run per shop at a time", async () => {
    sdk.trigger.mockResolvedValue({ id: "run_123" });
    expect(await enqueueShopAccessCheck(payload)).toBe("run_123");
    expect(sdk.createKey).toHaveBeenCalledWith("shop-access-check:omni-dev.myshopify.com:install", { scope: "global" });
    expect(sdk.trigger).toHaveBeenCalledWith("shop-access-check", payload, {
      idempotencyKey: "idem:shop-access-check:omni-dev.myshopify.com:install",
      idempotencyKeyTTL: "1h",
      concurrencyKey: "omni-dev.myshopify.com",
      tags: ["shop:omni-dev.myshopify.com", "reason:install"],
    });
  });

  it("never throws: no key, a failing API or a slow one all return null", async () => {
    vi.stubEnv("TRIGGER_SECRET_KEY", "");
    expect(await enqueueShopAccessCheck(payload)).toBeNull();
    expect(sdk.trigger).not.toHaveBeenCalled();

    vi.stubEnv("TRIGGER_SECRET_KEY", "tr_dev_test");
    sdk.trigger.mockRejectedValueOnce(new Error("503"));
    expect(await enqueueShopAccessCheck(payload)).toBeNull();

    vi.useFakeTimers();
    sdk.trigger.mockReturnValueOnce(new Promise(() => {}));
    const pending = enqueueShopAccessCheck(payload);
    await vi.advanceTimersByTimeAsync(TRIGGER_TIMEOUT_MS + 1);
    expect(await pending).toBeNull();
  });
});

describe("task payloads", () => {
  it("accept a myshopify domain and a known reason, and nothing else", () => {
    expect(shopAccessCheckPayload.safeParse(payload).success).toBe(true);
    expect(shopAccessCheckPayload.safeParse({ ...payload, shopDomain: "evil.example.com" }).success).toBe(false);
    expect(shopAccessCheckPayload.safeParse({ ...payload, reason: "whenever" }).success).toBe(false);
  });
});
