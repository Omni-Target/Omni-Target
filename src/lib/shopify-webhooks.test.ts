import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  capture: vi.fn(),
  recordShopRedact: vi.fn(),
  recordCustomerCompliance: vi.fn(),
  processWorkspaceDeletion: vi.fn(),
  processUnboundShopRedact: vi.fn(),
  afterTasks: [] as Array<() => Promise<unknown>>,
}));

vi.mock("@/lib/verify-shopify-hmac", () => ({ verifyShopifyHmac: h.verify }));
vi.mock("@/lib/observability/capture", () => ({ captureBackgroundFailure: h.capture }));
vi.mock("@/modules/workspaces/repository", () => ({
  recordShopRedact: h.recordShopRedact,
  recordCustomerCompliance: h.recordCustomerCompliance,
  processWorkspaceDeletion: h.processWorkspaceDeletion,
  processUnboundShopRedact: h.processUnboundShopRedact,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => h.afterTasks.push(task),
}));

import { handleShopifyPrivacyWebhook } from "./shopify-webhooks";

const deliver = (topic: string, body: unknown, headers: Record<string, string> = {}) =>
  handleShopifyPrivacyWebhook(
    new Request("http://localhost/api/webhooks/privacy", {
      method: "POST",
      headers: {
        "x-shopify-hmac-sha256": "sig",
        "x-shopify-topic": topic,
        "x-shopify-shop-domain": "header.myshopify.com",
        "x-shopify-webhook-id": "delivery-1",
        "x-shopify-triggered-at": "2026-11-09T10:00:00.000Z",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
const flush = async () => Promise.all(h.afterTasks.splice(0).map((task) => task()));
const redactBody = { shop_id: 954889, shop_domain: "s.myshopify.com" };

beforeEach(() => {
  vi.stubEnv("SHOPIFY_WEBHOOK_SECRET", "secret");
  for (const fn of [h.verify, h.capture, h.recordShopRedact, h.recordCustomerCompliance, h.processWorkspaceDeletion, h.processUnboundShopRedact]) fn.mockReset();
  h.afterTasks = [];
  h.verify.mockResolvedValue(true);
  h.recordShopRedact.mockResolvedValue({ outcome: "deletion_started", compliance_request_id: "req-1", deletion_id: "del-1" });
  h.recordCustomerCompliance.mockResolvedValue({ outcome: "completed" });
  h.processWorkspaceDeletion.mockResolvedValue({ outcome: "completed" });
  h.processUnboundShopRedact.mockResolvedValue({ outcome: "completed" });
});

describe("shop/redact (Phase 1 task 3)", () => {
  it("records the request from the signed body before answering, then deletes", async () => {
    const response = await deliver("shop/redact", redactBody);
    expect(response.status).toBe(200);
    expect(h.recordShopRedact).toHaveBeenCalledWith({
      shopifyShopId: 954889,
      domain: "s.myshopify.com",
      eventKey: "delivery-1",
      triggeredAt: "2026-11-09T10:00:00.000Z",
    });
    expect(h.processWorkspaceDeletion).not.toHaveBeenCalled();
    await flush();
    expect(h.processWorkspaceDeletion).toHaveBeenCalledWith("del-1");
  });

  it("redacts a shop with no workspace through the legacy path", async () => {
    h.recordShopRedact.mockResolvedValue({ outcome: "no_workspace", compliance_request_id: "req-2" });
    await deliver("shop/redact", redactBody);
    await flush();
    expect(h.processUnboundShopRedact).toHaveBeenCalledWith("req-2");
    expect(h.processWorkspaceDeletion).not.toHaveBeenCalled();
  });

  it("answers 500 so Shopify retries when the request cannot be recorded", async () => {
    h.recordShopRedact.mockRejectedValue(new Error("db down"));
    const response = await deliver("shop/redact", redactBody);
    expect(response.status).toBe(500);
    expect(h.afterTasks).toHaveLength(0);
    expect(h.capture).toHaveBeenCalledWith("shopify-compliance", expect.any(Error));
  });

  it("keeps the 200 when deletion fails afterwards, and reports it for the retry job", async () => {
    h.processWorkspaceDeletion.mockRejectedValue(new Error("timeout"));
    expect((await deliver("shop/redact", redactBody)).status).toBe(200);
    await flush();
    expect(h.capture).toHaveBeenCalledWith("shop-redaction", expect.any(Error));
  });
});

describe("customer compliance topics", () => {
  it("records and resolves them", async () => {
    const response = await deliver("customers/data_request", { shop_id: 954889, shop_domain: "s.myshopify.com", customer: { id: 1 } });
    expect(response.status).toBe(200);
    expect(h.recordCustomerCompliance).toHaveBeenCalledWith("customers/data_request", expect.objectContaining({ domain: "s.myshopify.com", shopifyShopId: 954889 }));
    expect(h.recordShopRedact).not.toHaveBeenCalled();
  });
});

describe("request authenticity", () => {
  it("records nothing for an invalid signature", async () => {
    h.verify.mockResolvedValue(false);
    expect((await deliver("shop/redact", redactBody)).status).toBe(401);
    expect(h.recordShopRedact).not.toHaveBeenCalled();
  });

  it("refuses a request that names no valid shop", async () => {
    const response = await deliver("shop/redact", { shop_domain: "evil.example.com" }, { "x-shopify-shop-domain": "evil.example.com" });
    expect(response.status).toBe(400);
    expect(h.recordShopRedact).not.toHaveBeenCalled();
  });
});
