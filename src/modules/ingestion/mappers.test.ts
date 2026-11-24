import { describe, expect, it } from "vitest";
import type { JsonlUnit } from "./jsonl";
import {
  destination,
  enumValue,
  mapCustomerUnit,
  mapInventoryLocations,
  mapInventoryUnit,
  mapLocation,
  mapMetafieldDefinition,
  mapMetaobject,
  mapMetaobjectDefinition,
  mapOrderUnit,
  metaobjectReferenceIds,
  orderAttribution,
  mapProductUnit,
  mapRefundNode,
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

  it("maps Phase 3's product and variant fields, and keeps absent values null (task 2)", () => {
    const description = `${"d".repeat(597)}...`;
    const mapped = mapProductUnit(unit(
      { id: "gid://shopify/Product/20", title: "Tee", status: "ACTIVE", description, category: { id: "gid://shopify/TaxonomyCategory/aa-1-13-8", fullName: "Apparel > T-Shirts" },
        options: [{ name: "Size" }, { name: "Colour" }], hasOnlyDefaultVariant: false, requiresSellingPlan: false, hasVariantsThatRequiresComponents: true,
        combinedListingRole: "PARENT", onlineStoreUrl: "https://shop.example/products/tee", mediaCount: { count: 3 },
        featuredMedia: { preview: { image: { url: "https://cdn.shopify.com/tee.jpg", altText: "A tee,\n  folded", width: 1075, height: 1200 } } } },
      [{ id: "gid://shopify/ProductVariant/21", __parentId: "gid://shopify/Product/20", price: "10", barcode: "5012345678900", availableForSale: true,
        requiresComponents: true, unitPriceMeasurement: { measuredType: "WEIGHT", quantityValue: 250, quantityUnit: "G", referenceValue: 100, referenceUnit: "G" },
        inventoryItem: { id: "gid://shopify/InventoryItem/22", harmonizedSystemCode: "610910", provinceCodeOfOrigin: "ON" } }],
    ));
    expect(mapped.product).toMatchObject({
      fields_version: 2, description_excerpt: description, description_truncated: true, category_id: "aa-1-13-8", option_names: ["Size", "Colour"],
      has_only_default_variant: false, requires_selling_plan: false, is_bundle: true, combined_listing_role: "parent",
      featured_image_url: "https://cdn.shopify.com/tee.jpg", featured_image_alt: "A tee, folded", featured_image_width: 1075, featured_image_height: 1200,
      media_count: 3, online_store_url: "https://shop.example/products/tee",
    });
    expect(mapped.variants[0]).toMatchObject({
      barcode: "5012345678900", available_for_sale: true, requires_components: true, harmonized_system_code: "610910", province_of_origin: "ON",
      unit_price_measurement: { measured_type: "weight", quantity_value: 250, quantity_unit: "g", reference_value: 100, reference_unit: "g" },
    });

    // Nothing Shopify did not give is filled in: no image, no category, no measurement (Shopify sends zeros and no type).
    const bare = mapProductUnit(unit({ id: "gid://shopify/Product/30", title: "Plain", status: "ACTIVE", description: "", featuredMedia: null, mediaCount: { count: 0 } },
      [{ id: "gid://shopify/ProductVariant/31", __parentId: "gid://shopify/Product/30", price: "5", barcode: null,
        unitPriceMeasurement: { measuredType: null, quantityValue: 0, quantityUnit: null, referenceValue: 0, referenceUnit: null } }]));
    expect(bare.product).toMatchObject({
      description_excerpt: null, description_truncated: false, category_id: null, featured_image_url: null, featured_image_alt: null, media_count: 0,
      combined_listing_role: null, online_store_url: null, option_names: [],
    });
    expect(bare.variants[0]).toMatchObject({ barcode: null, unit_price_measurement: null, available_for_sale: null });
    // A description read without the field (not requested) is unknown, not "not truncated".
    expect(mapProductUnit(unit({ id: "gid://shopify/Product/40", title: "Old", status: "ACTIVE" })).product?.description_truncated).toBeNull();
    // Empty alt text is Shopify's answer, kept as empty.
    expect(mapProductUnit(unit({ id: "gid://shopify/Product/41", title: "Img", status: "ACTIVE",
      featuredMedia: { preview: { image: { url: "https://cdn.shopify.com/x.jpg", altText: "" } } } })).product?.featured_image_alt).toBe("");
  });

  it("maps variant metafields under their variant, and drops those of a variant it could not map (task 2)", () => {
    const mapped = mapProductUnit(unit({ id: "gid://shopify/Product/50", title: "Board", status: "ACTIVE" }, [
      { id: "gid://shopify/ProductVariant/51", __parentId: "gid://shopify/Product/50", price: "300" },
      { id: "gid://shopify/Metafield/52", __parentId: "gid://shopify/ProductVariant/51", namespace: "specs", key: "length", type: "dimension", value: '{"value":150,"unit":"CENTIMETERS"}' },
      { id: "gid://shopify/ProductVariant/53", __parentId: "gid://shopify/Product/50" }, // no price: not stored
      { id: "gid://shopify/Metafield/54", __parentId: "gid://shopify/ProductVariant/53", namespace: "specs", key: "length", type: "dimension", value: "{}" },
      { id: "gid://shopify/Metafield/55", __parentId: "gid://shopify/Product/50", namespace: "shopify", key: "size", type: "list.metaobject_reference", value: '["gid://shopify/Metaobject/7"]' },
    ]));
    expect(mapped.metafields.map((m) => [m.owner_type, m.owner_shopify_id, m.product_shopify_id, m.key])).toEqual([
      ["variant", 51, 50, "length"], ["product", 50, 50, "size"],
    ]);
  });

  it("reads metaobject references from reference metafields only", () => {
    expect(metaobjectReferenceIds("list.metaobject_reference", '["gid://shopify/Metaobject/7","gid://shopify/Metaobject/8"]')).toEqual([7, 8]);
    expect(metaobjectReferenceIds("metaobject_reference", "gid://shopify/Metaobject/9")).toEqual([9]);
    expect(metaobjectReferenceIds("mixed_reference", "gid://shopify/Metaobject/10")).toEqual([10]);
    expect(metaobjectReferenceIds("single_line_text_field", "gid://shopify/Metaobject/9")).toEqual([]);
    expect(metaobjectReferenceIds("list.product_reference", '["gid://shopify/Product/1"]')).toEqual([]);
    expect(metaobjectReferenceIds("metaobject_reference", null)).toEqual([]);
  });

  it("maps definitions and metaobjects within their bounds; a metaobject's display name is its definition's display field", () => {
    expect(mapMetafieldDefinition({ id: "gid://shopify/MetafieldDefinition/1", namespace: "test_data", key: "snowboard_length", name: "Snowboard length",
      description: null, type: { name: "dimension" } }, "product")).toEqual({
      owner_type: "product", namespace: "test_data", key: "snowboard_length", shopify_id: 1, name: "Snowboard length", type: "dimension", description: null });
    expect(mapMetafieldDefinition({ id: "gid://shopify/MetafieldDefinition/2", namespace: "x", key: "y", type: { name: "boolean" } }, "variant")).toBeNull();
    expect(mapMetaobjectDefinition({ id: "gid://shopify/MetaobjectDefinition/3", type: "shopify--size", name: "Size", displayNameKey: "label",
      fieldDefinitions: [{ key: "label", name: "Label", type: { name: "single_line_text_field" } }] })).toEqual({
      shopify_id: 3, type: "shopify--size", name: "Size", display_name_key: "label", field_definitions: [{ key: "label", name: "Label", type: "single_line_text_field" }] });

    const size = mapMetaobject({ id: "gid://shopify/Metaobject/4", type: "shopify--size", handle: "small", updatedAt: "2026-11-01T00:00:00Z",
      fields: [{ key: "label", value: "Small" }, { key: "taxonomy_reference", value: "gid://shopify/TaxonomyValue/17" }, { key: "empty", value: null }] }, "label");
    expect(size).toEqual({ shopify_id: 4, type: "shopify--size", handle: "small", display_name: "Small",
      fields: { label: "Small", taxonomy_reference: "gid://shopify/TaxonomyValue/17" }, fields_truncated: false, shopify_updated_at: "2026-11-01T00:00:00Z" });
    expect(mapMetaobject({ id: "gid://shopify/Metaobject/5", type: "t", handle: "h", fields: [] }, null)?.display_name).toBe("h");
    // Long values are cut at 500 characters and the whole stays within 6 KB, marked truncated.
    const big = mapMetaobject({ id: "gid://shopify/Metaobject/6", type: "t", fields: Array.from({ length: 20 }, (_, i) => ({ key: `f${i}`, value: "v".repeat(600) })) }, null)!;
    expect(big.fields_truncated).toBe(true);
    expect(JSON.stringify(big.fields).length).toBeLessThanOrEqual(6_000);
    expect(Object.values(big.fields).every((v) => v.length === 500)).toBe(true);
    expect(mapMetaobject({ id: "gid://shopify/Product/1", type: "t" }, null)).toBeNull();
  });
});

describe("orders", () => {
  const order = (overrides: Record<string, unknown> = {}) => ({
    id: "gid://shopify/Order/20", name: "#1001", createdAt: "2026-03-01T10:00:00Z", processedAt: "2026-03-01T10:00:00Z", updatedAt: "2026-03-05T10:00:00Z",
    test: false, sourceName: "web", displayFinancialStatus: "PARTIALLY_REFUNDED", displayFulfillmentStatus: "FULFILLED", currencyCode: "GBP",
    presentmentCurrencyCode: "GBP", subtotalPriceSet: money("45.00"), totalDiscountsSet: money("5.00"), totalTaxSet: money("8.00"),
    totalShippingPriceSet: money("4.99"), totalPriceSet: money("52.99"), totalRefundedSet: money("10.00"), customer: { id: "gid://shopify/Customer/30" },
    shippingAddress: { city: "Leeds", provinceCode: "ENG", countryCodeV2: "GB" },
    refunds: [
      { id: "gid://shopify/Refund/40", createdAt: "2026-03-04T00:00:00Z", processedAt: "2026-02-20T09:00:00Z", totalRefundedSet: money("10.00", "GBP") },
      { id: "gid://shopify/Refund/41", createdAt: "2026-03-05T00:00:00Z", processedAt: null, totalRefundedSet: money("0.00", "GBP") },
    ],
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
      restockable: null, non_fulfillable_quantity: null, requires_shipping: null, is_gift_card: null,
    }]);
    // Not read: null, never a default (task 4).
    expect(mapped.order).toMatchObject({ product_network: null, return_status: null });
    // A refund's effective date is processedAt (backdated refunds), else createdAt.
    expect(mapped.refunds).toEqual([
      { shopify_id: 40, order_shopify_id: 20, shopify_created_at: "2026-03-04T00:00:00Z", processed_at: "2026-02-20T09:00:00Z", total_refunded: "10.00", currency: "GBP" },
      { shopify_id: 41, order_shopify_id: 20, shopify_created_at: "2026-03-05T00:00:00Z", processed_at: "2026-03-05T00:00:00Z", total_refunded: "0.00", currency: "GBP" },
    ]);
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

  it("maps inventory levels per location from every named quantity, and leaves unread ones null (task 3)", () => {
    const quantities = [["available", 4], ["committed", 2], ["incoming", 10], ["on_hand", 6], ["reserved", 1], ["damaged", 1], ["safety_stock", 0], ["quality_control", 0]];
    expect(mapInventoryUnit(unit({ id: "gid://shopify/InventoryItem/12" }, [
      { id: "gid://shopify/InventoryLevel/1?inventory_item_id=12", __parentId: "gid://shopify/InventoryItem/12", updatedAt: "2026-03-01T00:00:00Z", isActive: true,
        location: { id: "gid://shopify/Location/50" }, quantities: quantities.map(([name, quantity]) => ({ name, quantity })) },
      { id: "gid://shopify/InventoryLevel/2?inventory_item_id=12", __parentId: "gid://shopify/InventoryItem/12",
        location: { id: "gid://shopify/Location/51" }, quantities: [{ name: "available", quantity: 0 }] },
    ]))).toEqual([
      { inventory_item_id: 12, location_shopify_id: 50, available: 4, on_hand: 6, shopify_updated_at: "2026-03-01T00:00:00Z",
        committed: 2, incoming: 10, reserved: 1, damaged: 1, safety_stock: 0, quality_control: 0, is_active: true },
      { inventory_item_id: 12, location_shopify_id: 51, available: 0, on_hand: null, shopify_updated_at: null,
        committed: null, incoming: null, reserved: null, damaged: null, safety_stock: null, quality_control: null, is_active: null },
    ]);
  });

  it("maps a location with its fulfilment service (task 3)", () => {
    expect(mapLocation({ id: "gid://shopify/Location/50", name: "Warehouse", isActive: true, fulfillsOnlineOrders: true, isFulfillmentService: false, address: { countryCode: "GB", provinceCode: "ENG" } }))
      .toEqual({ shopify_id: 50, name: "Warehouse", country_code: "GB", province_code: "ENG", is_active: true, fulfills_online_orders: true, is_fulfillment_service: false,
        fields_version: 2, ships_inventory: null, has_active_inventory: null, deactivated_at: null, fulfillment_service_handle: null,
        fulfillment_service_name: null, fulfillment_service_type: null, fulfillment_service_inventory: null });
    expect(mapLocation({ id: "gid://shopify/Location/51", name: "ShipBob", isActive: true, fulfillsOnlineOrders: true, isFulfillmentService: true,
      shipsInventory: true, hasActiveInventory: true, fulfillmentService: { handle: "shipbob", serviceName: "ShipBob", type: "THIRD_PARTY", inventoryManagement: true } }))
      .toMatchObject({ is_fulfillment_service: true, fulfillment_service_handle: "shipbob", fulfillment_service_name: "ShipBob",
        fulfillment_service_type: "third_party", fulfillment_service_inventory: true, ships_inventory: true });
    expect(mapLocation({ id: "gid://shopify/Location/52", name: "X", fulfillmentService: { type: "SOMETHING_NEW" } })?.fulfillment_service_type).toBeNull();
  });

  it("takes the locations a by-ID inventory read names in full, once each, and none from a bulk export (task 3)", () => {
    const location = { id: "gid://shopify/Location/53", name: "New store", isActive: true, fulfillsOnlineOrders: false, isFulfillmentService: false };
    expect(mapInventoryLocations(unit({ id: "gid://shopify/InventoryItem/12" }, [
      { id: "gid://shopify/InventoryLevel/3", location, quantities: [] },
      { id: "gid://shopify/InventoryLevel/4", location, quantities: [] },
      { id: "gid://shopify/InventoryLevel/5", location: { id: "gid://shopify/Location/50" }, quantities: [] },
    ])).map((l) => [l.shopify_id, l.name, l.fulfills_online_orders])).toEqual([[53, "New store", false]]);
  });

  it("maps returns, their lines and their refunds from an order's descendants, with Phase 3's fields (task 4)", () => {
    const mapped = mapReturnsUnit(unit({ id: "gid://shopify/Order/20" }, [
      { id: "gid://shopify/Return/60", __parentId: "gid://shopify/Order/20", name: "#1001-R1", status: "CLOSED", totalQuantity: 1, createdAt: "2026-03-10T00:00:00Z",
        closedAt: "2026-03-15T00:00:00Z", requestApprovedAt: "2026-03-11T00:00:00Z", decline: null },
      { id: "gid://shopify/ReturnLineItem/61", __parentId: "gid://shopify/Return/60", quantity: 1, processedQuantity: 1, refundedQuantity: 1, unprocessedQuantity: 0,
        returnReasonDefinition: { handle: "size-too-small", name: "Size too small" }, customerNote: "never stored",
        fulfillmentLineItem: { lineItem: { id: "gid://shopify/LineItem/21" } }, restockingFee: { percentage: 10, amountSet: { shopMoney: { amount: "2.50" } } } },
      { id: "gid://shopify/Refund/40", __parentId: "gid://shopify/Return/60" },
      { id: "gid://shopify/Return/62", __parentId: "gid://shopify/Order/20", name: "#1001-R2", status: "DECLINED", decline: { reason: "FINAL_SALE", note: "never stored" } },
      { id: "gid://shopify/UnverifiedReturnLineItem/63", __parentId: "gid://shopify/Return/62", quantity: 2, processedQuantity: 0 },
    ]));
    expect(mapped.returns).toEqual([
      { shopify_id: 60, order_shopify_id: 20, name: "#1001-R1", status: "closed", total_quantity: 1, shopify_created_at: "2026-03-10T00:00:00Z", closed_at: "2026-03-15T00:00:00Z",
        fields_version: 2, decline_reason: null, request_approved_at: "2026-03-11T00:00:00Z" },
      { shopify_id: 62, order_shopify_id: 20, name: "#1001-R2", status: "declined", total_quantity: null, shopify_created_at: null, closed_at: null,
        fields_version: 2, decline_reason: "final_sale", request_approved_at: null },
    ]);
    expect(mapped.lineItems).toEqual([
      { shopify_id: 61, return_shopify_id: 60, line_item_shopify_id: 21, quantity: 1, return_reason: "size_too_small", processed_quantity: 1, refunded_quantity: 1,
        unprocessed_quantity: 0, return_reason_name: "Size too small", restocking_fee_amount: "2.50", restocking_fee_percentage: 10 },
      { shopify_id: 63, return_shopify_id: 62, line_item_shopify_id: null, quantity: 2, return_reason: null, processed_quantity: 0, refunded_quantity: null,
        unprocessed_quantity: null, return_reason_name: null, restocking_fee_amount: null, restocking_fee_percentage: null },
    ]);
    expect(mapped.returnRefunds).toEqual([{ return_shopify_id: 60, refund_shopify_id: 40 }]);
    expect(JSON.stringify(mapped)).not.toContain("never stored");
  });

  it("maps a refund read by ID with its lines, restock types and return (task 4)", () => {
    expect(mapRefundNode({ id: "gid://shopify/Refund/40", return: { id: "gid://shopify/Return/60" } }, [
      { id: "gid://shopify/RefundLineItem/70", quantity: 1, restockType: "RETURN", lineItem: { id: "gid://shopify/LineItem/21" }, subtotalSet: { shopMoney: { amount: "25.00" } } },
      { id: "gid://shopify/RefundLineItem/71", quantity: 2, restockType: "SOMETHING_NEW", lineItem: null },
      { id: "gid://shopify/LineItem/9", quantity: 1 },
    ])).toEqual({
      refund: { shopify_id: 40, return_shopify_id: 60 },
      lines: [
        { shopify_id: 70, refund_shopify_id: 40, line_item_shopify_id: 21, quantity: 1, restock_type: "return", subtotal: "25.00" },
        { shopify_id: 71, refund_shopify_id: 40, line_item_shopify_id: null, quantity: 2, restock_type: null, subtotal: null },
      ],
    });
    expect(mapRefundNode({ id: "gid://shopify/Order/1" }, [])).toBeNull();
  });

  it("normalises Shopify enumerations or drops ones that cannot be stored", () => {
    expect([enumValue("PARTIALLY_REFUNDED"), enumValue("size-too-small"), enumValue("123"), enumValue(null)]).toEqual(["partially_refunded", "size_too_small", null, null]);
  });
});

describe("order attribution (Phase 3, task 8)", () => {
  it("keeps the referrer's host, the landing path and UTM parameters, never a query string or a referral code", () => {
    const attribution = orderAttribution({
      ready: true, daysToConversion: 3, customerOrderIndex: 2,
      firstVisit: { source: "google", sourceType: "SEO" },
      lastVisit: { source: "instagram", sourceType: "AD", referralCode: "FRIEND-JANE",
        referrerUrl: "https://l.instagram.com/?u=https%3A%2F%2Fshop.example%2F&e=jane%40example.com",
        landingPage: "https://shop.example/products/lamp?utm_source=ig&email=jane@example.com&token=secret",
        utmParameters: { source: "instagram", medium: "paid_social", campaign: "x".repeat(150) } },
    });
    expect(attribution).toEqual({
      visit_source: "instagram", visit_source_type: "ad", referrer_host: "l.instagram.com", landing_path: "/products/lamp",
      utm_source: "instagram", utm_medium: "paid_social", utm_campaign: "x".repeat(100), first_visit_source: "google", first_visit_source_type: "seo",
      days_to_conversion: 3, customer_order_index: 2, journey_ready: true,
    });
    expect(JSON.stringify(attribution)).not.toMatch(/jane|secret|FRIEND/);
  });

  it("reads UTM parameters from the landing page when Shopify gives none, and nothing when there was no visit", () => {
    expect(orderAttribution({ ready: true, lastVisit: { landingPage: "/collections/sale?utm_source=newsletter&utm_medium=email" } }))
      .toMatchObject({ landing_path: "/collections/sale", referrer_host: null, utm_source: "newsletter", utm_medium: "email", utm_campaign: null });
    // An order created through the API: Shopify knows its place in the customer's orders, and no visit.
    expect(orderAttribution({ ready: true, daysToConversion: null, customerOrderIndex: 1, firstVisit: null, lastVisit: null })).toEqual({
      visit_source: null, visit_source_type: null, referrer_host: null, landing_path: null, utm_source: null, utm_medium: null, utm_campaign: null,
      first_visit_source: null, first_visit_source_type: null, days_to_conversion: null, customer_order_index: 1, journey_ready: true,
    });
    expect(orderAttribution(null).journey_ready).toBeNull();
  });
});
