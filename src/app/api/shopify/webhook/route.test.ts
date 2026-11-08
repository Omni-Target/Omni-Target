import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    integrations: [] as Record<string, unknown>[],
    capi: [] as Record<string, unknown>[],
    afterTasks: [] as Array<() => Promise<unknown>>,
    staleUpdates: [] as { filters: unknown[] }[],
    orderedByUpdatedAt: false,
    upsertError: null as null | { code: string; message: string },
    deliveries: [] as string[],
  };
  const from = (table: string) => {
    if (table === "user_integrations") {
      return {
        select: () => ({
          or: () => ({
            order: (column: string) => {
              state.orderedByUpdatedAt = column === "updated_at";
              return { limit: async () => ({ data: state.integrations.slice(0, 1), error: null }) };
            },
          }),
        }),
        update: () => ({
          eq: () => ({
            lt: async (...filters: unknown[]) => {
              state.staleUpdates.push({ filters });
              return { error: null };
            },
          }),
        }),
      };
    }
    if (table === "webhook_deliveries") {
      return {
        upsert: (row: Record<string, unknown>) => ({
          select: async () => {
            const key = `${row.shop_domain}|${row.webhook_id}`;
            if (state.deliveries.includes(key)) return { data: [], error: null };
            state.deliveries.push(key);
            return { data: [{ webhook_id: row.webhook_id }], error: null };
          },
        }),
      };
    }
    return {
      upsert: (row: Record<string, unknown>) => ({
        select: async () => {
          if (state.upsertError) return { data: null, error: state.upsertError };
          if (state.capi.some((r) => r.shop_domain === row.shop_domain && r.shopify_order_id === row.shopify_order_id && r.event_type === row.event_type)) return { data: [], error: null };
          const saved = { ...row, id: `claim-${state.capi.length + 1}` };
          state.capi.push(saved);
          return { data: [{ id: saved.id }], error: null };
        },
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: async (_c: string, id: string) => {
          Object.assign(state.capi.find((r) => r.id === id) ?? {}, patch);
          return { error: null };
        },
      }),
    };
  };
  return { state, from, verify: vi.fn(), sync: vi.fn(), revoke: vi.fn() };
});

vi.mock("@/lib/db", () => ({ supabaseAdmin: { from: h.from }, revokeShopAccess: h.revoke }));
vi.mock("@/lib/verify-shopify-hmac", () => ({ verifyShopifyHmac: h.verify }));
vi.mock("@/lib/connectors/shopify", () => ({ fetchShopifyStoreData: h.sync }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => h.state.afterTasks.push(task),
}));

import { POST } from "./route";

let nextDelivery = 0;
const deliver = (body: unknown, topic = "orders/paid", webhookId = `delivery-${++nextDelivery}`) =>
  POST(
    new Request("http://localhost/api/shopify/webhook", {
      method: "POST",
      headers: {
        "X-Shopify-Hmac-SHA256": "sig",
        "X-Shopify-Topic": topic,
        "X-Shopify-Shop-Domain": "s.myshopify.com",
        "X-Shopify-Webhook-Id": webhookId,
      },
      body: JSON.stringify(body),
    }),
  );
const flush = async () => {
  const tasks = h.state.afterTasks.splice(0);
  await Promise.all(tasks.map((t) => t()));
};
const order = { id: 1001, total_price: "50.00", currency: "USD", customer: { email: "a@b.co" } };
const fetchMock = vi.fn();

beforeEach(() => {
  Object.assign(h.state, {
    integrations: [{ clerk_user_id: "u1", meta_access_token: "meta-token", meta_pixel_id: "pixel" }],
    capi: [],
    afterTasks: [],
    staleUpdates: [],
    orderedByUpdatedAt: false,
    upsertError: null,
    deliveries: [],
  });
  h.verify.mockReset().mockResolvedValue(true);
  h.sync.mockReset();
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SHOPIFY_WEBHOOK_SECRET", "secret");
});

describe("Shopify order webhook (ING-05)", () => {
  it("acknowledges first and does the work after the response", async () => {
    const response = await deliver(order);
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a Meta event once when the same order is delivered twice", async () => {
    await deliver(order);
    await deliver(order);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.state.capi).toHaveLength(1);
    expect(h.state.capi[0]).toMatchObject({ status: "sent", shopify_order_id: "1001" });
  });

  it("records a failed send instead of leaving it pending", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    await deliver(order);
    await flush();
    expect(h.state.capi[0].status).toBe("failed");
  });

  it("never runs a full store sync; it marks an older snapshot stale", async () => {
    await deliver(order);
    await flush();
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.state.staleUpdates).toHaveLength(1);
  });

  it("uses the newest row when a shop has duplicate integrations", async () => {
    h.state.integrations.push({ clerk_user_id: "u2" });
    await deliver(order);
    await flush();
    expect(h.state.orderedByUpdatedAt).toBe(true);
    expect(h.state.capi[0].clerk_user_id).toBe("u1");
  });

  it("skips Meta when the store has not connected it, and for other topics", async () => {
    h.state.integrations = [{ clerk_user_id: "u1" }];
    await deliver(order);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    h.state.integrations = [{ clerk_user_id: "u1", meta_access_token: "t", meta_pixel_id: "p" }];
    await deliver(order, "products/update");
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokes credentials on app/uninstalled without touching Meta (SEC-09)", async () => {
    h.revoke.mockReset().mockResolvedValue(true);
    await deliver({}, "app/uninstalled");
    await flush();
    expect(h.revoke).toHaveBeenCalledWith("s.myshopify.com");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.state.staleUpdates).toHaveLength(0);
  });

  it("ignores a repeat of the same delivery, including when concurrent", async () => {
    const results = await Promise.all([deliver(order, "orders/paid", "w1"), deliver(order, "orders/paid", "w1"), deliver(order, "orders/paid", "w1")]);
    await flush();
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(bodies.filter((b) => b.duplicate)).toHaveLength(2);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not suppress later updates or refunds for the same order", async () => {
    await deliver(order, "orders/paid", "w1");
    await deliver(order, "orders/updated", "w2");
    await deliver({ id: 9, order_id: 1001 }, "refunds/create", "w3");
    await flush();
    expect(h.state.staleUpdates).toHaveLength(3); // each distinct event was processed
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the purchase went to Meta
  });

  it("never sends a second Purchase when orders/paid fires again under a new webhook id", async () => {
    await deliver(order, "orders/paid", "w1");
    await deliver(order, "orders/paid", "w2");
    await flush();
    expect(h.state.deliveries).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does no work for an invalid signature", async () => {
    h.verify.mockResolvedValue(false);
    const response = await deliver(order);
    expect(response.status).toBe(401);
    expect(h.state.afterTasks).toHaveLength(0);
  });
});
