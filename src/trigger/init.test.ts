import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  flush: vi.fn(async () => true),
  hooks: [] as Array<(params: unknown) => Promise<void> | void>,
}));
vi.mock("@sentry/node", () => ({ init: h.init, captureException: h.capture, flush: h.flush }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { onFailure: (hook: (params: unknown) => Promise<void>) => h.hooks.push(hook) } }));

describe("worker observability (Phase 2 task 3)", () => {
  it("starts Sentry with the app's scrubbing options and without default integrations", async () => {
    await import("./init");
    const options = h.init.mock.calls[0][0];
    expect(options.defaultIntegrations).toBe(false);
    expect(typeof options.beforeSend).toBe("function");
    expect(options.dataCollection).toMatchObject({ userInfo: false, httpBodies: [] });
  });

  it("reports a failed run by task, run and attempt, never its payload, and flushes before the worker exits", async () => {
    await import("./init");
    const error = new Error("boom");
    await h.hooks[0]({
      error,
      task: "shop-access-check",
      payload: { shopDomain: "omni-dev.myshopify.com", reason: "manual" },
      ctx: { environment: { type: "DEVELOPMENT" }, run: { id: "run_1" }, attempt: { number: 3 } },
    });
    expect(h.capture).toHaveBeenCalledWith(error, {
      tags: { job: "shop-access-check", trigger_environment: "DEVELOPMENT" },
      extra: { run_id: "run_1", attempt: 3 },
    });
    expect(JSON.stringify(h.capture.mock.calls[0])).not.toContain("omni-dev");
    expect(h.flush).toHaveBeenCalled();
  });
});
