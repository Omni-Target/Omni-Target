import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: vi.fn() };
  }
  return { default: MockAnthropic };
});

vi.mock("@/lib/db", () => ({
  logApiUsage: vi.fn(),
}));

import {
  shopifyGetPaginatedWithMeta,
  fetchMissingOrderProducts,
  fetchShopifyStoreData,
} from "./shopify";
import { buildProductDecisions } from "../gateway-decision";

vi.mock("./shopify-intelligence", () => ({
  fetchShopifyPrespendIntelligence: vi.fn().mockResolvedValue({
    prespend: {
      granted_scopes: [],
      missing_required_scopes: [],
      capabilities: {},
      markets: [],
      shipping_zones: [],
      fulfillment_locations: [],
      active_discounts: [],
      marketing_history: [],
      policies: [],
      locales: [],
    },
    products: {},
    returns: {},
    warnings: [],
  }),
}));

describe("large catalog & 70k+ SKU store sync resilience", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("caps pagination cleanly without throwing when allowPartial is true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const isPage1 = !url.includes("page_info=page2");
      return new Response(
        JSON.stringify({
          products: [
            {
              id: isPage1 ? 101 : 102,
              title: isPage1 ? "Product 101" : "Product 102",
              handle: "p",
              body_html: "",
              tags: "",
              product_type: "Tee",
              vendor: "Brand",
              created_at: "2026-01-01T00:00:00Z",
              variants: [{ id: 1, title: "Default", price: "25.00", inventory_quantity: 10 }],
              images: [],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: '<https://mega-store.myshopify.com/admin/api/2026-01/products.json?page_info=page2>; rel="next"',
          },
        }
      );
    });

    const result = await shopifyGetPaginatedWithMeta<{ id: number }>(
      "mega-store.myshopify.com",
      "shpat_test",
      "products.json?limit=250",
      "products",
      { maxPages: 2, allowPartial: true }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(true);
    expect(result.pagesFetched).toBe(2);
    expect(result.items.map((p) => p.id)).toEqual([101, 102]);
  });

  it("backfills order-referenced products that sit beyond initial catalog pages via products.json?ids=", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      expect(url).toContain("products.json?ids=70001,70002");
      return new Response(
        JSON.stringify({
          products: [
            {
              id: 70001,
              title: "Hero SKU #70001",
              handle: "hero-70001",
              body_html: "<p>Best seller</p>",
              tags: "bestseller",
              product_type: "Apparel",
              vendor: "MegaStore",
              created_at: "2026-01-01T00:00:00Z",
              variants: [{ id: 71, title: "M", price: "49.00", inventory_quantity: 12 }],
              images: [],
            },
            {
              id: 70002,
              title: "Runner-up SKU #70002",
              handle: "runner-70002",
              body_html: "",
              tags: "",
              product_type: "Apparel",
              vendor: "MegaStore",
              created_at: "2026-01-01T00:00:00Z",
              variants: [{ id: 72, title: "L", price: "39.00", inventory_quantity: 5 }],
              images: [],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const missing = await fetchMissingOrderProducts(
      "mega-store.myshopify.com",
      "shpat_test",
      [
        {
          id: 1,
          total_price: "147.00",
          created_at: "2026-10-15T10:00:00Z",
          financial_status: "paid",
          source_name: "web",
          line_items: [
            { product_id: 101, quantity: 1, price: "25.00" }, // already in existingProducts
            { product_id: 70001, quantity: 5, price: "49.00" }, // missing, highest volume
            { product_id: 70002, quantity: 2, price: "39.00" }, // missing, second highest
          ],
        },
      ],
      [
        {
          id: 101,
          title: "Already Fetched Product",
          handle: "already",
          body_html: "",
          tags: "",
          product_type: "",
          vendor: "",
          created_at: "2026-01-01T00:00:00Z",
          variants: [],
          images: [],
        },
      ]
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(missing.map((p) => p.id)).toEqual([70001, 70002]);
  });

  it("deduplicates concurrent fetchShopifyStoreData calls for the same shop domain", async () => {
    let shopCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/shop.json")) {
        shopCallCount++;
        await new Promise((r) => setTimeout(r, 30));
        return new Response(
          JSON.stringify({
            shop: {
              name: "Mega Catalog Store",
              domain: "megacatalog.com",
              myshopify_domain: "mega-catalog.myshopify.com",
              currency: "USD",
              country_code: "US",
              money_format: "${{amount}}",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/orders.json")) {
        return new Response(JSON.stringify({ orders: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ products: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const [first, second] = await Promise.all([
      fetchShopifyStoreData("mega-catalog.myshopify.com", "shpat_test", "user_1"),
      fetchShopifyStoreData("mega-catalog.myshopify.com", "shpat_test", "user_1"),
    ]);

    expect(shopCallCount).toBe(1);
    expect(first.store.name).toBe("Mega Catalog Store");
    expect(second.store.name).toBe("Mega Catalog Store");
  });

  it("treats pre-window repeat buyers (customer.orders_count > in-window orders) as later orders when ordersTruncated is true", () => {
    const decisions = buildProductDecisions(
      [
        // True new buyer #1 (orders_count = 1) bought product 10
        {
          id: 1,
          created_at: "2026-10-01T10:00:00Z",
          customer: { id: 1001, orders_count: 1 },
          line_items: [{ product_id: 10, quantity: 1 }],
        },
        // Legacy repeat buyer #2 (orders_count = 5, placed 4 orders years ago before the window)
        // Only has 1 order inside the truncated window for product 20
        {
          id: 2,
          created_at: "2026-10-02T10:00:00Z",
          customer: { id: 1002, orders_count: 5 },
          line_items: [{ product_id: 20, quantity: 1 }],
        },
      ],
      [
        { id: 10, variants: [{ inventory_quantity: 5 }] },
        { id: 20, variants: [{ inventory_quantity: 5 }] },
      ],
      {
        asOf: "2026-11-01T00:00:00Z",
        ingestionComplete: true,
        ordersTruncated: true,
      }
    );

    const prod10 = decisions.get(10)!;
    const prod20 = decisions.get(20)!;

    // Product 10 was bought by a true first-time buyer
    expect(prod10.first_order_count).toBe(1);
    expect(prod10.later_order_count).toBe(0);

    // Product 20 was bought by a 5-order veteran whose first 4 orders predate the window
    expect(prod20.first_order_count).toBe(0);
    expect(prod20.later_order_count).toBe(1);
  });
});
