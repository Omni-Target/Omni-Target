import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHOPIFY_REQUIRED_SCOPES } from "@/lib/shopify-config";
import { ACCESS_PROBE_QUERY, assertLevel1Query, buildAccessReport, type AccessProbeData } from "./access";

const ALL_SCOPES: string[] = [...SHOPIFY_REQUIRED_SCOPES];
const now = new Date("2026-11-18T00:00:00.000Z");
const probe = (overrides: Partial<AccessProbeData> = {}, scopes: string[] = ALL_SCOPES): AccessProbeData => ({
  currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
  shop: { id: "gid://shopify/Shop/1", currencyCode: "GBP", ianaTimezone: "Europe/London" },
  oldestOrder: { nodes: [{ id: "gid://shopify/Order/1", processedAt: "2023-02-01T00:00:00Z" }] },
  recentOrder: { nodes: [{ id: "gid://shopify/Order/9", processedAt: "2026-11-17T00:00:00Z" }] },
  customerProbe: { nodes: [{ id: "gid://shopify/Customer/5" }] },
  ...overrides,
});

describe("app configuration (Phase 2 decision 1)", () => {
  it("requests read_orders and read_all_orders, in shopify.app.toml exactly as in the OAuth scope list", () => {
    const toml = readFileSync("shopify.app.toml", "utf8");
    const declared = toml.match(/^scopes\s*=\s*"([^"]*)"/m)?.[1].split(",").map((scope) => scope.trim()).sort();
    expect(declared).toEqual([...SHOPIFY_REQUIRED_SCOPES].sort());
    expect(SHOPIFY_REQUIRED_SCOPES).toEqual(expect.arrayContaining(["read_orders", "read_all_orders"]));
  });
});

describe("Level 2 guard (Phase 2 decision 2)", () => {
  it("accepts the access probe", () => {
    expect(() => assertLevel1Query(ACCESS_PROBE_QUERY)).not.toThrow();
  });

  it("rejects names, contact details, address lines and zip codes", () => {
    for (const field of ["email", "phone", "firstName", "lastName", "displayName", "address1", "zip", "defaultAddress", "billingAddress"]) {
      expect(() => assertLevel1Query(`query { customers(first: 1) { nodes { id ${field} } } }`), field).toThrow(/Level 2/);
    }
    expect(() => assertLevel1Query("query { orders(first: 1) { nodes { shippingAddress { city name } } } }")).toThrow(/beyond the destination/);
  });

  it("does not mistake product fields for customer data", () => {
    expect(() => assertLevel1Query("query { products(first: 1) { nodes { title vendor emailTemplate: handle } } }")).not.toThrow();
  });
});

describe("capability matrix", () => {
  it("reports every domain available with full scopes, and the 24-month window with read_all_orders", () => {
    const report = buildAccessReport(probe(), [], now);
    expect(Object.values(report.domains).map((d) => d.status)).toEqual(Array(7).fill("available"));
    expect(report.domains.orders.history).toEqual({
      from: "2024-11-18T00:00:00.000Z", basis: "retention_window", missing_scope: null, oldest_reachable_order_at: "2023-02-01T00:00:00Z",
    });
    expect(report.shop).toEqual({ currency: "GBP", timezone: "Europe/London" });
  });

  it("limits orders to 60 days, as partial, without read_all_orders", () => {
    const report = buildAccessReport(probe({}, ALL_SCOPES.filter((s) => s !== "read_all_orders")), [], now);
    expect(report.domains.orders).toMatchObject({ status: "partial", reasons: ["missing_scope:read_all_orders"] });
    expect(report.domains.orders.history).toMatchObject({ basis: "read_orders_only", missing_scope: "read_all_orders", from: "2026-09-19T00:00:00.000Z" });
  });

  it("marks a domain inaccessible when a required scope is missing, and returns depend on orders too", () => {
    const report = buildAccessReport(probe({}, ALL_SCOPES.filter((s) => s !== "read_orders" && s !== "read_all_orders")), [], now);
    expect(report.domains.orders).toMatchObject({ status: "inaccessible", reasons: ["missing_scope:read_orders"] });
    expect(report.domains.returns).toMatchObject({ status: "inaccessible", reasons: ["missing_scope:read_orders"] });
    expect(report.domains.orders.history).toMatchObject({ from: null, basis: "no_order_access" });
  });

  it("records withheld destination and customer fields, and leaves the rest of the domain available", () => {
    const report = buildAccessReport(probe(), ["recentOrder.nodes.shippingAddress.city", "customerProbe.nodes.amountSpent.amount"], now);
    expect(report.withheldFields).toEqual({
      "Order.shippingAddress.city": { domain: "orders", reason: "ACCESS_DENIED" },
      "Customer.amountSpent": { domain: "customers", reason: "ACCESS_DENIED" },
    });
    expect(report.domains.orders).toMatchObject({ status: "partial", reasons: ["withheld:Order.shippingAddress.city"] });
    expect(report.domains.customers).toMatchObject({ status: "partial", reasons: ["withheld:Customer.amountSpent"] });
  });

  it("treats a denial of the whole connection as inaccessible", () => {
    const report = buildAccessReport(probe({ customerProbe: null }), ["customerProbe"], now);
    expect(report.domains.customers).toEqual({ status: "inaccessible", reasons: ["access_denied"] });
  });

  it("says which fields could not be checked when the shop has no orders or customers yet", () => {
    const report = buildAccessReport(probe({ recentOrder: { nodes: [] }, customerProbe: { nodes: [] }, oldestOrder: { nodes: [] } }), [], now);
    expect(report.domains.orders.unverified_fields).toContain("Order.shippingAddress.city");
    expect(report.domains.customers.unverified_fields).toContain("Customer.numberOfOrders");
    expect(report.domains.orders.history?.oldest_reachable_order_at).toBeNull();
  });

  it("verifies a field only from a record that has a value for it", () => {
    const guest = buildAccessReport(probe({ recentOrder: { nodes: [{ id: "gid://shopify/Order/9", customer: null, shippingAddress: null }] } }), [], now);
    expect(guest.domains.orders.unverified_fields).toEqual(expect.arrayContaining(["Order.customer", "Order.shippingAddress.city", "Order.shippingAddress.countryCodeV2"]));
    const full = buildAccessReport(probe({
      recentOrder: { nodes: [{ id: "gid://shopify/Order/9", customer: { id: "gid://shopify/Customer/1" }, shippingAddress: { city: "Leeds", provinceCode: "ENG", countryCodeV2: "GB" } }] },
      customerProbe: { nodes: [{ id: "gid://shopify/Customer/1", numberOfOrders: "2", amountSpent: { amount: "10.0", currencyCode: "GBP" }, createdAt: "2025-01-01T00:00:00Z" }] },
    }), [], now);
    expect(full.domains.orders.unverified_fields).toBeUndefined();
    expect(full.domains.customers.unverified_fields).toBeUndefined();
  });

  it("accepts a write scope for its read scope", () => {
    const scopes = ALL_SCOPES.filter((s) => s !== "read_products").concat("write_products");
    expect(buildAccessReport(probe({}, scopes), [], now).domains.catalog.status).toBe("available");
  });
});
