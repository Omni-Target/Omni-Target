import { describe, expect, it } from "vitest";
import type { JsonlUnit } from "./jsonl";
import {
  destination,
  enumValue,
  mapCustomerUnit,
  mapInventoryUnit,
  mapLocation,
  mapOrderUnit,
  mapProductUnit,
  mapReturnsUnit,
} from "./mappers";

const unit = (root: Record<string, unknown>, children: Record<string, unknown>[] = []): JsonlUnit => ({ root, children, firstLine: 1, lastLine: 1 + children.length });
const money = (amount: string, currencyCode?: string) => ({ shopMoney: { amount, ...(currencyCode ? { currencyCode } : {}) } });

describe("catalog", () => {
  it("maps a product with its variants and metafields, within the schema's bounds", () => {
    const mapped = mapProductUnit(unit(
      { id: "gid://shopify/Product/10", title: "Lamp", handle: "lamp", status: "ACTIVE", productType: "Lighting", vendor: "Acme",
        tags: ["a", "", "b"], isGiftCard: false, publishedAt: "2026-01-01T00:00:00Z", createdAt: "2025-12-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z", category: { fullName: "Home > Lighting" }, description: "Warm light" },
      [
        { id: "gid://shopify/ProductVariant/11", __parentId: "gid://shopify/Product/10", title: "Brass", sku: "L-1", position: 1, price: "25.00",
          compareAtPrice: null, taxable: true, inventoryPolicy: "DENY", inventoryQuantity: 4, selectedOptions: [{ name: "Finish", value: "Brass" }],
          inventoryItem: { id: "gid://shopify/InventoryItem/12", tracked: true, requiresShipping: true, countryCodeOfOrigin: "GB",
            unitCost: { amount: "9.50", currencyCode: "GBP" }, measurement: { weight: { value: 1.2, unit: "KILOGRAMS" } } } },
        { id: "gid://shopify/ProductVariant/13", __parentId: "gid://shopify/Product/10", price: "30.00", inventoryItem: { unitCost: { amount: "5.00" } } },
        { id: "gid://shopify/Metafield/14", __parentId: "gid://shopify/Product/10", namespace: "specs", key: "wattage", type: "number_integer", value: "40", updatedAt: "2026-02-01T00:00:00Z" },
        { id: "gid://shopify/Metafield/15", __parentId: "gid://shopify/Product/10", namespace: "custom", key: "long", type: "multi_line_text_field", value: "x".repeat(1200) },
      ],
    ));
    expect(mapped.product).toMatchObject({ shopify_id: 10, status: "active", tags: ["a", "b"], category: "Home > Lighting", description_excerpt: "Warm light" });
    expect(mapped.variants[0]).toMatchObject({
      shopify_id: 11, product_shopify_id: 10, price: "25.00", inventory_policy: "deny", inventory_item_id: 12, weight: "1.2",
      weight_unit: "kilograms", unit_cost: "9.50", unit_cost_currency: "GBP", country_of_origin: "GB", selected_options: [{ name: "Finish", value: "Brass" }],
    });
    // A cost without its currency is not stored (the table requires both or neither).
    expect(mapped.variants[1]).toMatchObject({ shopify_id: 13, unit_cost: null, unit_cost_currency: null, inventory_item_id: null });
    expect(mapped.metafields.map((m) => [m.key, m.value_excerpt?.length, m.value_truncated])).toEqual([["wattage", 2, false], ["long", 1000, true]]);
  });

  it("drops a record of the wrong type rather than storing a wrong ID", () => {
    expect(mapProductUnit(unit({ id: "gid://shopify/Collection/1" })).product).toBeNull();
  });
});

describe("orders", () => {
  const order = (overrides: Record<string, unknown> = {}) => ({
    id: "gid://shopify/Order/20", name: "#1001", createdAt: "2026-03-01T10:00:00Z", processedAt: "2026-03-01T10:00:00Z", updatedAt: "2026-03-05T10:00:00Z",
    test: false, sourceName: "web", displayFinancialStatus: "PARTIALLY_REFUNDED", displayFulfillmentStatus: "FULFILLED", currencyCode: "GBP",
    presentmentCurrencyCode: "GBP", subtotalPriceSet: money("45.00"), totalDiscountsSet: money("5.00"), totalTaxSet: money("8.00"),
    totalShippingPriceSet: money("4.99"), totalPriceSet: money("52.99"), totalRefundedSet: money("10.00"), customer: { id: "gid://shopify/Customer/30" },
    shippingAddress: { city: "Leeds", provinceCode: "ENG", countryCodeV2: "GB" },
    refunds: [{ id: "gid://shopify/Refund/40", createdAt: "2026-03-04T00:00:00Z", totalRefundedSet: money("10.00", "GBP") }],
    ...overrides,
  });
  const lines = [
    { id: "gid://shopify/LineItem/21", __parentId: "gid://shopify/Order/20", title: "Lamp", sku: "L-1", quantity: 2, currentQuantity: 1,
      product: { id: "gid://shopify/Product/10" }, variant: { id: "gid://shopify/ProductVariant/11" }, originalUnitPriceSet: money("25.00"), totalDiscountSet: money("5.00") },
  ];

  it("maps an order with its lines and refunds; a line's refunded units are what left the order", () => {
    const mapped = mapOrderUnit(unit(order(), lines));
    expect(mapped.order).toMatchObject({
      shopify_id: 20, financial_status: "partially_refunded", fulfillment_status: "fulfilled", currency: "GBP", presentment_currency: null,
      total_price: "52.99", total_refunded: "10.00", customer_shopify_id: 30, ship_country_code: "GB", ship_city: "Leeds", ship_city_raw: null,
    });
    expect(mapped.lineItems).toEqual([{
      shopify_id: 21, order_shopify_id: 20, product_shopify_id: 10, variant_shopify_id: 11, title: "Lamp", sku: "L-1",
      quantity: 2, current_quantity: 1, refunded_quantity: 1, unit_price: "25.00", total_discount: "5.00",
    }]);
    expect(mapped.refunds).toEqual([{ shopify_id: 40, order_shopify_id: 20, shopify_created_at: "2026-03-04T00:00:00Z", total_refunded: "10.00", currency: "GBP" }]);
  });

  it("stores the presentment currency only when it differs, and a guest order with no customer", () => {
    const mapped = mapOrderUnit(unit(order({ presentmentCurrencyCode: "EUR", customer: null, shippingAddress: null })));
    expect(mapped.order).toMatchObject({ presentment_currency: "EUR", customer_shopify_id: null, ship_country_code: null, ship_city: null });
  });

  it("refuses an order without its required fields", () => {
    expect(mapOrderUnit(unit(order({ totalPriceSet: null }))).order).toBeNull();
    expect(mapOrderUnit(unit(order({ currencyCode: "gbp" }))).order).toBeNull();
  });

  it("normalises the city by the order's own country (GEO-01), keeping the raw value only when it differs", () => {
    expect(destination({ city: "Riverside", provinceCode: "CA", countryCodeV2: "US" })).toEqual({ ship_country_code: "US", ship_province_code: "CA", ship_city: "Riverside", ship_city_raw: null });
    expect(destination({ city: "Ikeja", countryCodeV2: "NG" })).toMatchObject({ ship_city: "Lagos", ship_city_raw: "Ikeja" });
    expect(destination({ city: "Lagos", countryCodeV2: "PT" })).toMatchObject({ ship_city: "Lagos", ship_city_raw: null });
  });
});

describe("customers, inventory, locations and returns", () => {
  it("maps a customer from Level 1 fields only", () => {
    expect(mapCustomerUnit(unit({ id: "gid://shopify/Customer/30", numberOfOrders: "3", amountSpent: { amount: "120.50", currencyCode: "GBP" }, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" })))
      .toEqual({ shopify_id: 30, orders_count: 3, amount_spent: "120.50", amount_spent_currency: "GBP", shopify_created_at: "2025-01-01T00:00:00Z", shopify_updated_at: "2026-01-01T00:00:00Z" });
  });

  it("maps inventory levels per location from named quantities", () => {
    expect(mapInventoryUnit(unit({ id: "gid://shopify/InventoryItem/12" }, [
      { id: "gid://shopify/InventoryLevel/1?inventory_item_id=12", __parentId: "gid://shopify/InventoryItem/12", updatedAt: "2026-03-01T00:00:00Z",
        location: { id: "gid://shopify/Location/50" }, quantities: [{ name: "available", quantity: 4 }, { name: "on_hand", quantity: 6 }] },
    ]))).toEqual([{ inventory_item_id: 12, location_shopify_id: 50, available: 4, on_hand: 6, shopify_updated_at: "2026-03-01T00:00:00Z" }]);
  });

  it("maps a location", () => {
    expect(mapLocation({ id: "gid://shopify/Location/50", name: "Warehouse", isActive: true, fulfillsOnlineOrders: true, isFulfillmentService: false, address: { countryCode: "GB", provinceCode: "ENG" } }))
      .toEqual({ shopify_id: 50, name: "Warehouse", country_code: "GB", province_code: "ENG", is_active: true, fulfills_online_orders: true, is_fulfillment_service: false });
  });

  it("maps returns and their lines from an order's descendants", () => {
    const mapped = mapReturnsUnit(unit({ id: "gid://shopify/Order/20" }, [
      { id: "gid://shopify/Return/60", __parentId: "gid://shopify/Order/20", name: "#1001-R1", status: "CLOSED", totalQuantity: 1, createdAt: "2026-03-10T00:00:00Z", closedAt: "2026-03-15T00:00:00Z" },
      { id: "gid://shopify/ReturnLineItem/61", __parentId: "gid://shopify/Return/60", quantity: 1, returnReasonDefinition: { handle: "size-too-small" },
        fulfillmentLineItem: { lineItem: { id: "gid://shopify/LineItem/21" } } },
    ]));
    expect(mapped.returns).toEqual([{ shopify_id: 60, order_shopify_id: 20, name: "#1001-R1", status: "closed", total_quantity: 1, shopify_created_at: "2026-03-10T00:00:00Z", closed_at: "2026-03-15T00:00:00Z" }]);
    expect(mapped.lineItems).toEqual([{ shopify_id: 61, return_shopify_id: 60, line_item_shopify_id: 21, quantity: 1, return_reason: "size_too_small" }]);
  });

  it("normalises Shopify enumerations or drops ones that cannot be stored", () => {
    expect([enumValue("PARTIALLY_REFUNDED"), enumValue("size-too-small"), enumValue("123"), enumValue(null)]).toEqual(["partially_refunded", "size_too_small", null, null]);
  });
});
