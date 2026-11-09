import { describe, expect, it } from "vitest";
import {
  connectionRefusalMessage,
  isRefusal,
  lifecycleEventKey,
  parseShopifyShopId,
  parseTriggeredAt,
  uninstallClearsCredentials,
  webhookShopDomain,
} from "./lifecycle";

describe("parseShopifyShopId", () => {
  it("accepts a positive integer as number or digits", () => {
    expect(parseShopifyShopId(548380009)).toBe(548380009);
    expect(parseShopifyShopId("548380009")).toBe(548380009);
  });

  it("rejects anything else", () => {
    for (const value of [null, undefined, 0, -4, 1.5, "", "12a", "gid://shopify/Shop/1", "1".repeat(17), Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseShopifyShopId(value), String(value)).toBeNull();
    }
  });
});

describe("parseTriggeredAt", () => {
  it("normalises Shopify's timestamp and rejects junk", () => {
    expect(parseTriggeredAt("2026-11-09T18:00:27.877041743Z")).toBe("2026-11-09T18:00:27.877Z");
    expect(parseTriggeredAt("yesterday")).toBeNull();
    expect(parseTriggeredAt(null)).toBeNull();
  });
});

describe("webhookShopDomain", () => {
  it("prefers the signed body over the unsigned header", () => {
    expect(webhookShopDomain({ shop_domain: "Real.myshopify.com" }, "other.myshopify.com")).toBe("real.myshopify.com");
    expect(webhookShopDomain({ myshopify_domain: "real.myshopify.com" }, "other.myshopify.com")).toBe("real.myshopify.com");
  });

  it("falls back to the header, and only ever returns a myshopify domain", () => {
    expect(webhookShopDomain({}, "shop.myshopify.com")).toBe("shop.myshopify.com");
    expect(webhookShopDomain({ shop_domain: "evil.example.com" }, null)).toBeNull();
    expect(webhookShopDomain(null, "evil.example.com")).toBeNull();
  });
});

describe("lifecycleEventKey", () => {
  it("uses Shopify's webhook id when present", () => {
    expect(lifecycleEventKey({ webhookId: "b54557e4-bdd9", topic: "app/uninstalled", domain: "s.myshopify.com", rawBody: "{}" })).toBe("b54557e4-bdd9");
  });

  it("derives a stable key from the signed body otherwise", () => {
    const input = { webhookId: null, topic: "shop/redact", domain: "s.myshopify.com", rawBody: '{"shop_id":1}' };
    expect(lifecycleEventKey(input)).toBe(lifecycleEventKey(input));
    expect(lifecycleEventKey(input)).not.toBe(lifecycleEventKey({ ...input, rawBody: '{"shop_id":2}' }));
  });
});

describe("uninstallClearsCredentials", () => {
  it("clears credentials unless the uninstall predates a reconnection", () => {
    expect(uninstallClearsCredentials({ outcome: "pending_deletion" })).toBe(true);
    expect(uninstallClearsCredentials({ outcome: "no_workspace" })).toBe(true);
    expect(uninstallClearsCredentials({ outcome: "stale" })).toBe(false);
  });

  it("follows the first delivery's decision on a retry", () => {
    expect(uninstallClearsCredentials({ outcome: "duplicate", recorded_outcome: "pending_deletion" })).toBe(true);
    expect(uninstallClearsCredentials({ outcome: "duplicate", recorded_outcome: "stale" })).toBe(false);
  });
});

describe("connection refusals", () => {
  it("explains each refusal without naming the other account", () => {
    expect(connectionRefusalMessage("rejected_other_owner")).toMatch(/another Omnitarget account/);
    expect(connectionRefusalMessage("rejected_deletion_in_progress")).toMatch(/being deleted/);
    expect(connectionRefusalMessage("rejected_invalid_identity")).toMatch(/could not verify/);
    expect(isRefusal("rejected_legacy_claim")).toBe(true);
    expect(isRefusal("reconnected")).toBe(false);
  });
});
