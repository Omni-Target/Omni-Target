import { describe, expect, it } from "vitest";
import { mapOrderUnit, mapProductUnit } from "./mappers";
import { chunkUnits, groupResources, resourceOf, SYNC_TOPICS, thinPayload, unitFromNode } from "./sync-events";

describe("thin sync events (task 10)", () => {
  it("keeps identifiers and change times only, never a customer's data", () => {
    expect(thinPayload({
      id: 820982911946154500, updated_at: "2026-11-22T10:00:00Z", email: "jon@example.com", customer: { id: 1, email: "x" },
      shipping_address: { address1: "1 Main St" }, admin_graphql_api_id: "gid://shopify/Order/1", line_items: [{ id: 2 }], status: "open",
    })).toEqual({ id: 820982911946154500, updated_at: "2026-11-22T10:00:00Z", admin_graphql_api_id: "gid://shopify/Order/1", status: "open" });
    expect(thinPayload(null)).toEqual({});
    expect(thinPayload(["id"])).toEqual({});
  });

  it("names the resource each topic is about", () => {
    expect(resourceOf("orders/updated", { id: 11, updated_at: "t" })).toEqual({ kind: "order", id: 11 });
    expect(resourceOf("orders/delete", { id: "12" })).toEqual({ kind: "order", id: 12 });
    expect(resourceOf("refunds/create", { id: 99, order_id: 13 })).toEqual({ kind: "order", id: 13 });
    expect(resourceOf("products/delete", { id: 7 })).toEqual({ kind: "product", id: 7 });
    expect(resourceOf("customers/update", { id: 501 })).toEqual({ kind: "customer", id: 501 });
    expect(resourceOf("inventory_levels/update", { inventory_item_id: 40, location_id: 2 })).toEqual({ kind: "inventory", id: 40 });
    expect(resourceOf("returns/update", { admin_graphql_api_id: "gid://shopify/Return/77", status: "OPEN" })).toEqual({ kind: "return", id: 77 });
    expect(resourceOf("returns/close", { id: 78, order_id: 13 })).toEqual({ kind: "return", id: 78 });
    expect(resourceOf("orders/paid", { id: 11 })).toBeNull();
    expect(resourceOf("orders/updated", { id: -1 })).toBeNull();
    expect(SYNC_TOPICS.has("orders/paid")).toBe(false);
  });

  it("fetches a resource once however many deliveries name it, in any order", () => {
    const { resources, unusable } = groupResources([
      { id: "e1", topic: "orders/updated", payload: { id: 11, updated_at: "2026-11-22T10:02:00Z" } },
      { id: "e2", topic: "orders/create", payload: { id: 11, updated_at: "2026-11-22T10:00:00Z" } },
      { id: "e3", topic: "refunds/create", payload: { order_id: 11 } },
      { id: "e4", topic: "products/update", payload: { id: 7 } },
      { id: "e5", topic: "orders/updated", payload: {} },
    ]);
    expect(resources).toEqual([{ kind: "order", id: 11, eventIds: ["e1", "e2", "e3"] }, { kind: "product", id: 7, eventIds: ["e4"] }]);
    expect(unusable).toEqual(["e5"]);
  });

  it("reads a by-ID node as the bulk mappers read an export", () => {
    const order = unitFromNode({
      id: "gid://shopify/Order/11", name: "#1011", createdAt: "2026-11-01T00:00:00Z", processedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z",
      test: false, currencyCode: "GBP", totalPriceSet: { shopMoney: { amount: "25.00" } }, customer: { id: "gid://shopify/Customer/501" },
      refunds: [],
      lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [
        { node: { id: "gid://shopify/LineItem/111", quantity: 2, currentQuantity: 2, product: { id: "gid://shopify/Product/7" }, originalUnitPriceSet: { shopMoney: { amount: "10.00" } } } },
      ] },
    });
    expect(order.children).toEqual([expect.objectContaining({ id: "gid://shopify/LineItem/111", __parentId: "gid://shopify/Order/11" })]);
    expect(order.root).not.toHaveProperty("lineItems");
    const mapped = mapOrderUnit(order);
    expect(mapped.order).toMatchObject({ shopify_id: 11, customer_shopify_id: 501 });
    expect(mapped.lineItems).toEqual([expect.objectContaining({ shopify_id: 111, order_shopify_id: 11, product_shopify_id: 7, quantity: 2 })]);

    const product = mapProductUnit(unitFromNode({
      id: "gid://shopify/Product/7", title: "Lamp", status: "ACTIVE", updatedAt: "2026-11-02T00:00:00Z",
      variants: { edges: [{ node: { id: "gid://shopify/ProductVariant/70", price: "10.00", inventoryItem: { id: "gid://shopify/InventoryItem/700" } } }] },
      metafields: { edges: [{ node: { id: "gid://shopify/Metafield/1", namespace: "specs", key: "watts", type: "number_integer", value: "40" } }] },
    }));
    expect(product.product).toMatchObject({ shopify_id: 7 });
    expect(product.variants).toEqual([expect.objectContaining({ shopify_id: 70, product_shopify_id: 7, inventory_item_id: 700 })]);
    expect(product.metafields).toHaveLength(1);
  });

  it("keeps each unit whole within the row bound", () => {
    const unit = (children: number) => ({ root: { id: "x" }, children: Array.from({ length: children }, () => ({})), firstLine: 0, lastLine: 0 });
    expect(chunkUnits([unit(3), unit(3), unit(3)], 8).map((chunk) => chunk.length)).toEqual([2, 1]);
    expect(chunkUnits([unit(20)], 8).map((chunk) => chunk.length)).toEqual([1]);
    expect(chunkUnits([], 8)).toEqual([]);
  });
});
