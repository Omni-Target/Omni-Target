import { describe, expect, it, vi } from "vitest";

// The snapshot computation's module builds an AI client and a usage log on import; neither is used here.
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock("@/lib/db", () => ({ logApiUsage: vi.fn() }));

import type { ShopifyIntelligenceResult } from "@/lib/connectors/shopify-intelligence";
import {
  buildCanonicalStoreData, canonicalEnrichment, toShopifyOrder, toShopifyProduct, type CanonicalInsightsDeps, type CanonicalOrder, type CanonicalProduct,
} from "./canonical";

const order = (id: number, at: string, lines: CanonicalOrder["lines"], extra: Partial<CanonicalOrder> = {}): CanonicalOrder => ({
  id, processed_at: at, total_price: "30.0000", subtotal: "25.0000", financial_status: "paid", source_name: "web", customer_id: 501,
  customer_orders: 3, customer_created_at: "2024-01-02T00:00:00Z", city: "Leeds", province_code: "ENG", country_code: "GB", lines, ...extra,
});
const product = (id: number, extra: Partial<CanonicalProduct> = {}): CanonicalProduct => ({
  id, title: `Product ${id}`, handle: `p-${id}`, description: "A lamp", tags: ["home", "light"], product_type: "Lamp", vendor: "V", status: "active",
  created_at: "2024-01-01T00:00:00Z",
  variants: [{ id: id * 10, title: "Default", price: "12.5000", inventory_quantity: 4, unit_cost: "5.0000", unit_cost_currency: "GBP" }],
  metafields: [{ namespace: "specs", key: "material", type: "single_line_text_field", value: "Oak" }], ...extra,
});
const intelligence = (): ShopifyIntelligenceResult => ({
  prespend: {
    granted_scopes: [], missing_required_scopes: [], capabilities: {}, markets: [], shipping_zones: [], fulfillment_locations: [],
    active_discounts: [], marketing_history: [], policies: [], locales: [],
  },
  products: { 999: { unitCost: 1, currency: "GBP", costCoverage: "complete", claims: [] } },
  returns: {},
  warnings: [],
});

describe("the mirror in the snapshot computation's shape (task 11)", () => {
  it("dates an order by its processed time, keeps its customer and destination, and drops lines without a product", () => {
    const mapped = toShopifyOrder(order(1, "2024-05-20T10:00:00Z", [
      { product_id: 7, variant_id: 70, quantity: 2, price: "12.5000" },
      { product_id: null, variant_id: null, quantity: 1, price: "3.0000" },
    ]));
    expect(mapped).toEqual({
      id: 1, total_price: "30", subtotal_price: "25", created_at: "2024-05-20T10:00:00Z",
      customer: { id: 501, orders_count: 3, created_at: "2024-01-02T00:00:00Z" },
      shipping_address: { city: "Leeds", province_code: "ENG", country_code: "GB", country: "United Kingdom" },
      financial_status: "paid", source_name: "web", referring_site: null, landing_site: null,
      line_items: [{ product_id: 7, variant_id: 70, quantity: 2, price: "12.5" }],
    });
    expect(toShopifyOrder(order(2, "2024-05-20T10:00:00Z", [], { customer_id: null, city: null, province_code: null, country_code: null })))
      .toMatchObject({ customer: undefined, shipping_address: undefined });
  });

  it("maps a product with its variants, tags and image, and its cost and catalog evidence", () => {
    expect(toShopifyProduct(product(7), "https://cdn.example/7.jpg")).toEqual({
      id: 7, title: "Product 7", handle: "p-7", body_html: "A lamp", tags: "home, light", product_type: "Lamp", vendor: "V",
      created_at: "2024-01-01T00:00:00Z", variants: [{ id: 70, title: "Default", price: "12.5", inventory_quantity: 4 }],
      images: [{ src: "https://cdn.example/7.jpg" }],
    });
    const partial = product(8, { variants: [...product(8).variants, { id: 81, title: "Big", price: "20", inventory_quantity: null, unit_cost: null, unit_cost_currency: null }] });
    expect(canonicalEnrichment([product(7), partial])).toEqual({
      7: { unitCost: 5, currency: "GBP", costCoverage: "complete", claims: [{ key: "specs.material", value: "Oak", source: "product_metafield" }] },
      8: { unitCost: 5, currency: "GBP", costCoverage: "partial", claims: [{ key: "specs.material", value: "Oak", source: "product_metafield" }] },
    });
  });

  it("passes tracking and policy on, and counts what the online locations hold when levels are stored (task 3)", () => {
    const mapped = toShopifyProduct(product(5, { variants: [
      { id: 51, title: "Untracked", price: "10", inventory_quantity: 0, unit_cost: null, unit_cost_currency: null, tracked: false, inventory_policy: "deny", available_online: null },
      { id: 52, title: "Online stock", price: "10", inventory_quantity: 9, unit_cost: null, unit_cost_currency: null, tracked: true, inventory_policy: "deny", available_online: "4" },
      { id: 53, title: "Keeps selling", price: "10", inventory_quantity: 0, unit_cost: null, unit_cost_currency: null, tracked: true, inventory_policy: "continue", available_online: 0 },
      { id: 54, title: "Read before 0046", price: "10", inventory_quantity: 3, unit_cost: null, unit_cost_currency: null },
    ] }));
    expect(mapped.variants).toEqual([
      { id: 51, title: "Untracked", price: "10", inventory_quantity: 0, inventory_management: null, inventory_policy: "deny" },
      { id: 52, title: "Online stock", price: "10", inventory_quantity: 4, inventory_management: "shopify", inventory_policy: "deny" },
      { id: 53, title: "Keeps selling", price: "10", inventory_quantity: 0, inventory_management: "shopify", inventory_policy: "continue" },
      { id: 54, title: "Read before 0046", price: "10", inventory_quantity: 3 },
    ]);
  });

  it("claims a referenced metaobject's fields, never its IDs, and each distinct variant value once (task 2)", () => {
    const sized = product(9, { metafields: [
      { owner: "product", namespace: "shopify", key: "material", type: "metaobject_reference", value: "gid://shopify/Metaobject/5" },
      { owner: "product", namespace: "shopify", key: "color", type: "list.metaobject_reference", value: '["gid://shopify/Metaobject/6"]' },
      { owner: "variant", namespace: "specs", key: "length", type: "dimension", value: '{"value":150,"unit":"cm"}' },
      { owner: "variant", namespace: "specs", key: "length", type: "dimension", value: '{"value":150,"unit":"cm"}' },
      { owner: "variant", namespace: "specs", key: "length", type: "dimension", value: '{"value":160,"unit":"cm"}' },
      { owner: "variant", namespace: "specs", key: "fits", type: "list.product_reference", value: '["gid://shopify/Product/1"]' },
    ] });
    const metaobjects = new Map([[5, { id: 5, type: "shopify--material", display_name: "Oak", fields: { label: "Oak", taxonomy_reference: "gid://shopify/TaxonomyValue/1" } }]]);
    expect(canonicalEnrichment([sized], metaobjects)[9].claims).toEqual([
      { key: "shopify--material.label", value: "Oak", source: "referenced_metaobject" },
      { key: "specs.length", value: '{"value":150,"unit":"cm"}', source: "variant_metafield" },
      { key: "specs.length", value: '{"value":160,"unit":"cm"}', source: "variant_metafield" },
    ]);
  });
});

describe("buildCanonicalStoreData (task 11)", () => {
  function deps(orders: CanonicalOrder[], catalogIds: number[], active = catalogIds.length) {
    const sorted = [...orders].sort((a, b) => (a.processed_at === b.processed_at ? b.id - a.id : b.processed_at.localeCompare(a.processed_at)));
    const d = {
      ordersPage: vi.fn(async (before: { at: string; id: number } | null, limit: number) => {
        const start = before ? sorted.findIndex((o) => o.processed_at === before.at && o.id === before.id) + 1 : 0;
        return sorted.slice(start, start + limit);
      }),
      catalog: vi.fn(async () => ({ active, ids: catalogIds })),
      products: vi.fn(async (ids: number[]) => ids.map((id) => product(id))),
      shop: vi.fn(async () => ({ name: "Shop", domain: "shop.example", myshopify_domain: "s.myshopify.com", currency: "GBP", country_code: "GB" })),
      intelligence: vi.fn(async () => intelligence()),
      images: vi.fn(async (ids: number[]) => new Map(ids.map((id) => [id, `https://cdn.example/${id}.jpg`]))),
      metaobjects: vi.fn(async (ids: number[]) => ids.map((id) => ({ id, type: "shopify--size", display_name: `Size ${id}`, fields: { label: `L${id}` } }))),
      ingestionComplete: vi.fn(async () => true),
    } satisfies CanonicalInsightsDeps;
    return d;
  }
  const many = (n: number) => Array.from({ length: n }, (_, i) =>
    order(i + 1, new Date(Date.UTC(2026, 10, 1) - i * 3_600_000).toISOString(), [{ product_id: 7 + (i % 2), variant_id: null, quantity: 1, price: "10" }]));

  it("analyses the mirror's orders and products with the snapshot computation", async () => {
    const d = deps(many(5), [7, 9]);
    const { data, inputs } = await buildCanonicalStoreData("s.myshopify.com", d);
    expect(inputs).toMatchObject({ source: "canonical", orders: 5, ordersTruncated: false, products: 3, activeProducts: 2, productsWithImages: 3 });
    expect(data.orders.order_count).toBe(5);
    expect(data.data_quality?.schema_version).toBe(9);
    // The products the orders reference join the catalog, once each, with their images and the mirror's costs.
    expect(d.products).toHaveBeenCalledWith([7, 9, 8]);
    const lamp = data.products.find((p) => p.id === "7");
    expect(lamp).toMatchObject({ image_url: "https://cdn.example/7.jpg", unit_cost: 5 });
  });

  it("takes images from the mirror, reading from Shopify only products not yet read with Phase 3's fields (task 2)", async () => {
    const d = deps(many(2), [7, 9]);
    d.products.mockImplementation(async (ids: number[]) => ids.map((id) => product(id, id === 9 ? {} : { fields_version: 2, image_url: id === 7 ? "https://cdn.mirror/7.jpg" : null })));
    const { data, inputs } = await buildCanonicalStoreData("s.myshopify.com", d);
    expect(d.images).toHaveBeenCalledWith([9]);
    expect(inputs.productsWithImages).toBe(2);
    expect(data.products.find((p) => p.id === "7")).toMatchObject({ image_url: "https://cdn.mirror/7.jpg" });
    // Read with Phase 3's fields and without an image: none, not a Shopify read.
    expect(data.products.find((p) => p.id === "8")?.image_url).toBe("");
  });

  it("resolves the metaobjects products reference from the mirror (task 2)", async () => {
    const d = deps(many(1), [7]);
    d.products.mockImplementation(async (ids: number[]) => ids.map((id) => product(id, {
      fields_version: 2, metafields: [{ owner: "product", namespace: "shopify", key: "size", type: "list.metaobject_reference", value: '["gid://shopify/Metaobject/41","gid://shopify/Metaobject/42"]' }],
    })));
    const { data } = await buildCanonicalStoreData("s.myshopify.com", d);
    expect(d.metaobjects).toHaveBeenCalledWith([41, 42]);
    expect(data.products.find((p) => p.id === "7")?.catalog_claims).toEqual([
      { key: "shopify--size.label", value: "L41", source: "referenced_metaobject" },
      { key: "shopify--size.label", value: "L42", source: "referenced_metaobject" },
    ]);
  });

  it("reads orders newest first in pages, and reports truncation only when more remain", async () => {
    const exact = deps(many(6), [7]);
    expect((await buildCanonicalStoreData("s.myshopify.com", exact, { orderLimit: 6 })).inputs).toMatchObject({ orders: 6, ordersTruncated: false });
    const more = deps(many(7), [7]);
    expect((await buildCanonicalStoreData("s.myshopify.com", more, { orderLimit: 6 })).inputs).toMatchObject({ orders: 6, ordersTruncated: true });
    const first = (more.ordersPage.mock.calls[0] as unknown[]);
    expect(first).toEqual([null, 6]);
  });
});
