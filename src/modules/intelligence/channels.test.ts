import { describe, expect, it } from "vitest";
import { channelFit, classifyGroup, CHANNEL_RULES, normaliseChannelEvidence, type ChannelEvidence, type ChannelGroup, type ChannelScopeEvidence } from "./channels";

/** Phase 5, task 5: channel fit from recorded journeys. ILLUSTRATIVE counts. */
const group = (orders: number, g: Partial<ChannelGroup>, first = 0): ChannelGroup => ({ referrer_host: null, utm_source: null, utm_medium: null,
  visit_source: null, source_name: "web", journey_known: true, orders, first_orders: first, ...g });
const scope = (groups: ChannelGroup[]): ChannelScopeEvidence => ({ orders: groups.reduce((t, g) => t + g.orders, 0),
  journey_known: groups.filter((g) => g.journey_known).reduce((t, g) => t + g.orders, 0), groups });
const evidence = (product: ChannelScopeEvidence | null, store: ChannelScopeEvidence = scope([])): ChannelEvidence =>
  ({ as_of: "2026-11-28T00:00:00Z", window_days: 365, store, products: [{ product_id: 1, channels: product }] });

describe("classifying a journey", () => {
  it("uses the app's own classifier on the stored referrer and UTMs", () => {
    expect(classifyGroup(group(1, { utm_source: "instagram" }))).toBe("meta");
    expect(classifyGroup(group(1, { referrer_host: "l.facebook.com" }))).toBe("meta");
    expect(classifyGroup(group(1, { referrer_host: "www.google.com" }))).toBe("google");
    expect(classifyGroup(group(1, { utm_source: "klaviyo", utm_medium: "email" }))).toBe("email");
    expect(classifyGroup(group(1, { utm_source: "tiktok" }))).toBe("tiktok");
    expect(classifyGroup(group(1, { visit_source: "google" }))).toBe("google");
    expect(classifyGroup(group(1, { visit_source: "direct" }))).toBe("direct");
    expect(classifyGroup(group(1, { referrer_host: "someblog.example" }))).toBe("referral");
    expect(classifyGroup(group(1, { source_name: "pos", journey_known: false }))).toBe("in_person");
  });

  it("never calls an order without a recorded journey direct", () => {
    expect(classifyGroup(group(1, { journey_known: false }))).toBeNull();
    expect(classifyGroup(group(1, { journey_known: false, source_name: "shopify_draft_order" }))).toBeNull();
  });
});

describe("channel fit", () => {
  it("names the channels that sell the product, with first-order shares; Meta is not assumed", () => {
    const own = scope([group(30, { referrer_host: "www.google.com" }, 27), group(12, { utm_source: "klaviyo", utm_medium: "email" }, 1),
      group(6, { utm_source: "facebook" }, 6), group(2, { visit_source: "direct" }, 1), group(10, { journey_known: false })]);
    const fit = channelFit(evidence(own), 1);
    expect(fit).toMatchObject({ scope: "product", status: "measured", orders: 60, attributed: 50, coverage: 0.833, meta: { status: "present", share: 0.12 } });
    expect(fit.channels.map((c) => [c.channel, c.orders, c.share, c.status])).toEqual([
      ["google", 30, 0.6, "supported"], ["email", 12, 0.24, "supported"], ["meta", 6, 0.12, "present"], ["direct", 2, 0.04, "present"]]);
    expect(fit.channels.find((c) => c.channel === "email")!.first_order_share).toBe(0.083);   // email brings buyers back
    expect(fit.explanation).toMatch(/Google \(search and YouTube\) 60%, Email 24% sell it; Meta has brought 12%/);
  });

  it("says Meta has brought nothing when no attributed order came from it", () => {
    const fit = channelFit(evidence(scope([group(25, { referrer_host: "www.google.com" })])), 1);
    expect(fit.meta).toEqual({ status: "absent", share: 0 });
    expect(fit.explanation).toMatch(/Meta has brought none so far/);
  });

  it("falls back to the store when the product has too few attributed orders, and says so", () => {
    const store = scope([group(40, { utm_source: "instagram" }), group(20, { referrer_host: "www.google.com" })]);
    const fit = channelFit(evidence(scope([group(5, { utm_source: "instagram" })]), store), 1);
    expect(fit).toMatchObject({ scope: "store", meta: { status: "supported", share: 0.667 } });
    expect(fit.explanation).toMatch(/the store's \(the product has too few attributed orders\)/);
  });

  it("is unknown when too few orders carry a journey (orders created through the API carry none)", () => {
    const apiOrders = scope([group(800, { journey_known: false }), group(30, { utm_source: "instagram" })]);
    const fit = channelFit(evidence(apiOrders, apiOrders), 1);
    expect(fit).toMatchObject({ scope: "none", status: "unknown", channels: [], meta: { status: "unknown", share: null } });
    expect(fit.explanation).toMatch(/30 of 830 paid orders carry a recorded visit/);
    expect(CHANNEL_RULES.minCoverage).toBe(0.3);
  });

  it("supports a channel only at 20% and 10 orders", () => {
    const fit = channelFit(evidence(scope([group(15, { referrer_host: "www.google.com" }), group(9, { utm_source: "instagram" }), group(1, { utm_source: "tiktok" })])), 1);
    expect(fit.channels.map((c) => [c.channel, c.status])).toEqual([["google", "supported"], ["meta", "present"], ["tiktok", "present"]]);
  });

  it("reads the database's evidence", () => {
    const e = normaliseChannelEvidence({ as_of: "x", window_days: 365, store: { orders: "3", journey_known: 1, groups: [{ utm_source: "fb", journey_known: true, orders: "1", first_orders: 1 }] },
      products: [{ product_id: "2", channels: null }] });
    expect(e).toMatchObject({ store: { orders: 3, groups: [{ utm_source: "fb", referrer_host: null, orders: 1 }] }, products: [{ product_id: 2, channels: null }] });
  });
});
