import { describe, expect, it } from "vitest";
import { evaluateProductQuality, QUALITY_FIELDS, type ProductQualityFacts, type ShopQualityContext } from "./rules";

const facts = (extra: Partial<ProductQualityFacts> = {}): ProductQualityFacts => ({
  product_id: 1, status: "active", fields_version: 2, is_gift_card: false, collective: false, has_description: true, description_truncated: false,
  has_category: true, has_image: true, media_count: 2, variants: 2, zero_price: 0, with_cost: 2, cost_currencies: ["GBP"], shipped: 2,
  shipped_without_weight: 0, shipping_unknown: 0, with_barcode: 2, with_compare_at: 0, compare_at_not_above: 0, with_hs_code: 2, with_origin: 2,
  tracked: 2, untracked: 0, keep_selling: 0, tracked_with_levels: 2, levels: 2, levels_unknown_location: 0, levels_partial_quantities: 0,
  levels_third_party: 0, metafields: 3, metafields_defined: 3, metafields_truncated: 0, references: 1, references_unresolved: 0, ...extra,
});
const shop: ShopQualityContext = { currency: "GBP", scopes: ["read_products", "read_inventory"], inventoryImported: true, returnsImported: true };
const state = (f: ProductQualityFacts, s: ShopQualityContext = shop, signals: Parameters<typeof evaluateProductQuality>[1] = []) => {
  const q = evaluateProductQuality(f, signals, s);
  return Object.fromEntries(QUALITY_FIELDS.map((field) => [field, `${q.flags[field].state}:${q.flags[field].reason}`]));
};

describe("product data-quality flags (Phase 3, task 6)", () => {
  it("marks a complete product present, with counts that add up", () => {
    const q = evaluateProductQuality(facts(), [{ signal: "gift_card", trust: "verified", source: "shopify_product", detail: null }], shop);
    expect(q.calc_version).toBe(1);
    expect(Object.values(q.flags).every((f) => f.state === "present" || f.reason === "not_on_sale")).toBe(true);
    expect(q.counts.present + q.counts.empty + q.counts.missing + q.counts.unavailable + q.counts.unverified).toBe(QUALITY_FIELDS.length);
  });

  it("keeps what the merchant did not set (missing) apart from what is genuinely not needed (empty)", () => {
    expect(state(facts({ with_cost: 0 })).unit_cost).toBe("missing:not_set");
    expect(state(facts({ with_cost: 1 })).unit_cost).toBe("missing:partial");
    expect(state(facts({ with_barcode: 0 })).barcode).toBe("missing:not_set");
    expect(state(facts({ has_category: false })).category).toBe("missing:uncategorised");
    expect(state(facts({ shipped: 2, shipped_without_weight: 2 })).weight).toBe("missing:not_set");
    expect(state(facts({ shipped: 0, shipped_without_weight: 0 })).weight).toBe("empty:not_shipped");
    expect(state(facts({ with_compare_at: 0 })).compare_at_price).toBe("empty:not_on_sale");
    expect(state(facts({ has_image: false, media_count: 0 })).images).toBe("empty:none");
    expect(state(facts({ has_image: false, media_count: 3 })).images).toBe("missing:no_featured");
    expect(state(facts({ metafields: 0, metafields_defined: 0 })).specifications).toBe("empty:none_defined");
    expect(state(facts({ untracked: 2, tracked: 0, tracked_with_levels: 0 })).inventory).toBe("empty:untracked");
    expect(state(facts({ is_gift_card: true })).weight).toBe("empty:gift_card");
  });

  it("marks what could not be read unavailable, with the reason", () => {
    expect(state(facts(), { ...shop, scopes: ["read_products"] }).unit_cost).toBe("unavailable:scope_missing");
    expect(state(facts(), { ...shop, inventoryImported: false }).inventory).toBe("unavailable:inventory_not_imported");
    expect(state(facts({ tracked_with_levels: 1 })).inventory).toBe("unavailable:no_level_stored");
    expect(state(facts({ fields_version: null, has_image: false })).images).toBe("unavailable:not_read");
    expect(state(facts({ fields_version: null })).specifications).toBe("unavailable:not_read");
    expect(state(facts({ fields_version: null })).barcode).toBe("unavailable:not_read");
    expect(state(facts(), { ...shop, returnsImported: false }).return_eligibility).toBe("unavailable:returns_not_imported");
    // No signal is not proof that a product is returnable.
    expect(state(facts()).return_eligibility).toBe("unavailable:no_product_rule");
    expect(state(facts({ variants: 0 })).price).toBe("unavailable:no_variants");
  });

  it("marks values that rest on merchant free text, are incomplete or contradict themselves unverified", () => {
    expect(state(facts(), shop, [{ signal: "tag", trust: "unverified", source: "merchant_tag", detail: "Final Sale" }]).return_eligibility).toBe("unverified:tag");
    expect(state(facts(), shop, [{ signal: "tag", trust: "unverified", source: "merchant_tag", detail: "x" },
      { signal: "declined_final_sale", trust: "observed", source: "shopify_return_decline", detail: "#1-R1" }]).return_eligibility).toBe("present:declined_final_sale");
    expect(state(facts({ cost_currencies: ["USD"] })).unit_cost).toBe("unverified:currency_differs");
    expect(state(facts({ zero_price: 1 })).price).toBe("unverified:zero_price");
    expect(state(facts({ with_compare_at: 1, compare_at_not_above: 1 })).compare_at_price).toBe("unverified:not_above_price");
    expect(state(facts({ references_unresolved: 1 })).specifications).toBe("unverified:reference_unresolved");
    expect(state(facts({ metafields_defined: 0 })).specifications).toBe("unverified:no_definitions");
    expect(state(facts({ levels_partial_quantities: 1 })).inventory).toBe("unverified:quantities_partial");
    expect(state(facts({ levels_unknown_location: 1 })).fulfilment).toBe("unverified:unknown_location");
  });

  it("names who fulfils a product, Shopify Collective first", () => {
    expect(state(facts({ collective: true })).fulfilment).toBe("present:shopify_collective");
    expect(state(facts({ levels_third_party: 1 })).fulfilment).toBe("present:third_party");
    expect(state(facts()).fulfilment).toBe("present:merchant");
  });

  it("never claims present for a value that is not there (property, 2,000 random products)", () => {
    let seed = 42;
    const rand = (max: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % (max + 1); };
    for (let i = 0; i < 2_000; i++) {
      const n = rand(4);
      const f = facts({
        variants: n, with_cost: rand(n), with_barcode: rand(n), zero_price: rand(n), shipped: rand(n), with_hs_code: rand(n), with_origin: rand(n),
        tracked: rand(n), has_image: rand(1) === 1, has_category: rand(1) === 1, has_description: rand(1) === 1, metafields: rand(3),
        fields_version: rand(1) === 1 ? 2 : null, media_count: rand(2), levels: rand(3),
      });
      f.shipped_without_weight = rand(f.shipped);
      f.metafields_defined = rand(f.metafields);
      f.tracked_with_levels = rand(f.tracked);
      f.untracked = n - f.tracked;
      const q = evaluateProductQuality(f, [], { ...shop, scopes: rand(1) ? shop.scopes : ["read_products"], inventoryImported: rand(1) === 1 });
      const where = JSON.stringify(f);
      if (q.flags.unit_cost.state === "present") expect(f.with_cost, where).toBe(n);
      if (q.flags.barcode.state === "present") expect(f.with_barcode, where).toBe(n);
      if (q.flags.images.state === "present") expect(f.has_image, where).toBe(true);
      if (q.flags.category.state === "present") expect(f.has_category, where).toBe(true);
      if (q.flags.description.state === "present") expect(f.has_description, where).toBe(true);
      if (q.flags.specifications.state === "present") expect(f.metafields_defined, where).toBeGreaterThan(0);
      if (q.flags.weight.state === "present") expect(f.shipped_without_weight, where).toBe(0);
      if (q.flags.inventory.state === "present") expect(f.tracked_with_levels, where).toBe(f.tracked);
      if (q.flags.customs.state === "present") expect([f.with_hs_code, f.with_origin], where).toEqual([n, n]);
      if (q.flags.price.state === "present") expect(f.zero_price, where).toBe(0);
      // And a field read before Phase 3's fields is never called empty or missing: it is unavailable.
      if (f.fields_version === null) for (const field of ["images", "specifications", "barcode", "customs"] as const) {
        if (!(field === "images" && f.has_image)) expect(q.flags[field].state, `${field} ${where}`).toMatch(/unavailable|empty/);
        if (field !== "images") expect(q.flags[field].reason, field).not.toBe("not_set");
      }
    }
  });
});
