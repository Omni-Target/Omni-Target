import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BriefStep } from "@/components/campaigns/steps/brief-step";
import { buildBriefPdfPayload, buildBriefText, budgetPlanFor } from "@/lib/campaigns/brief";
import { buildBriefHTML } from "@/lib/brief-html-template";
import type { AiInsights, GeneratedCopy, StoreInsights } from "@/components/campaigns/types";
import { boundBriefEvidence, isBoundedEvidence } from "./evidence";

/** As stored: brief_data goes through jsonb. */
const stored = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const PRODUCT = "Heavyweight Organic Tee";
const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `word${(seed * 31 + i) % 97}`).join(" ");

/** A store snapshot shaped like the real one, with a 1,000-product catalog and the bulky sections. */
function snapshot({
  products = 1000,
  includeProduct = true,
  analytics = true,
  prespend = true,
  country = "NG",
  currency = "NGN",
  locations = [
    { city: "Lagos", country: "NG", percentage: 61, raw_cities: ["Lagos", "Ikeja", "Lekki"] },
    { city: "Abuja", country: "NG", percentage: 18 },
    { city: "London", country: "GB", percentage: 9 },
    { city: "Houston", country: "US", percentage: 7 },
    { city: "Accra", country: "GH", percentage: 5 },
  ],
} = {}) {
  const catalog = Array.from({ length: products }, (_, i) => ({
    id: 9000 + i,
    name: i === 7 && includeProduct ? PRODUCT : `Product ${i}`,
    handle: `product-${i}`,
    description: words(80, i).slice(0, 600),
    tags: i % 5 === 0 ? ["one"] : ["cotton", "summer", "new"],
    price: 20 + (i % 40),
    image_url: `https://cdn.example.com/p/${i}.jpg`,
    in_stock: i % 9 !== 0,
    revenue: 1000 - i,
    units_sold: 400 - (i % 400),
    order_count: i % 3 === 0 ? 3 : 40,
    order_velocity: 1.5,
    repeat_purchase_rate: 0.2,
    first_time_buyer_ratio: 0.6,
    unit_cost: i % 4 === 0 ? null : 8.5,
    unit_cost_currency: currency,
    unit_cost_coverage: i % 4 === 0 ? "missing" : "complete",
    price_less_unit_cost: i % 4 === 0 ? null : 11.5,
    product_decision: { readiness_reasons: [words(20, i)], limitations: [words(15, i)], test_readiness: "review" },
    catalog_claims: [{ key: "material", value: "cotton", source: "product_metafield" }],
  }));
  return {
    generated_at: "2026-11-01T00:00:00.000Z",
    store: { name: "Ada Wear", domain: "adawear.com", myshopify_domain: "ada-wear.myshopify.com", country, currency, currency_symbol: currency === "NGN" ? "₦" : "$", platform: "shopify", total_products: products },
    orders: {
      total_revenue: 120000, order_count: 1800, average_order_value: 66.5, top_locations: locations,
      peak_days: ["Friday", "Saturday", "Sunday"], peak_hours: [19, 20, 21], repeat_customer_rate: 0.22,
      revenue_last_30_days: 9000, orders_last_30_days: 140, acquisition_channels: [{ channel: "Instagram", order_count: 90, percentage: 64 }],
    },
    products: catalog,
    customers: { total_count: 1500, new_count: 300, returning_count: 1200 },
    ...(prespend
      ? {
          prespend: {
            granted_scopes: ["read_products", "read_orders"],
            missing_required_scopes: [],
            capabilities: { analytics: { status: "available", required_scopes: ["read_reports"] } },
            ...(analytics
              ? {
                  analytics: {
                    source: "shopifyql", window_days: 30, sessions: 5400, visitors: 4100, conversion_rate: 0.021,
                    recent_funnel: { source: "shopifyql_sessions", window_days: 30, sessions: 5400, cart_sessions: 410, checkout_sessions: 190, completed_checkout_sessions: 120, checkout_conversion_rate: 0.63 },
                    top_countries: Array.from({ length: 20 }, (_, i) => ({ country: `C${i}`, sessions: 100 - i, completed_checkouts: 3, conversion_rate: 0.03 })),
                  },
                }
              : {}),
            markets: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `Market ${i}`, status: "ACTIVE", countries: ["NG", "GH"] })),
            shipping_zones: [], fulfillment_locations: [], active_discounts: [],
            marketing_history: Array.from({ length: 50 }, (_, i) => ({ title: words(10, i) })),
            policies: [{ type: "refund", body: words(400, 3) }],
            locales: [{ locale: "en", primary: true, published: true }],
          },
        }
      : {}),
    data_quality: {
      schema_version: 9, ingestion_complete: true, history_basis: "accessible_paid_orders", anonymous_orders: 12, orders_without_city: 30,
      warnings: ["Some orders have no city."], gateway_signal_validation: { details: words(200, 9) },
    },
  } as unknown as StoreInsights;
}

const copy: GeneratedCopy = { headline: "Built to last", primaryText: "Heavyweight cotton that keeps its shape.", description: "Organic cotton tee", cta: "Shop Now", copywriterNote: "Lead with durability." };

function insights(peakDays: string[] = []): AiInsights {
  return {
    generation_status: "generated",
    creative_hooks_status: "generated",
    creative_hooks: [
      { angle: "Problem", visual_cue: "Tee after 30 washes", on_screen_text: "Still the same shape.", primary_text_hook: "Most tees give up early. Ours does not." },
      { angle: "Identity", visual_cue: "Street shot", on_screen_text: "Quiet quality.", primary_text_hook: "Made for people who notice." },
      { angle: "Material", visual_cue: "Fabric macro", on_screen_text: "Organic cotton.", primary_text_hook: "Feel the weight." },
    ],
    targeting: { age_min: 24, age_max: 40, gender: "All", interests: ["Fashion"], age_reasoning: "Store buyers." },
    budget: { currency: "NGN", currency_symbol: "₦", reasoning: "Merchant cap only." },
    timing: { peak_days: peakDays },
    warnings: ["Check stock before launch."],
  };
}

const views = async (storeInsights: StoreInsights | null, ai: AiInsights, maxTestBudget: number | null, selectedDuration: 7 | 14 | 30) => {
  const common = { aiInsights: ai, storeInsights, selectedDuration, selectedIntlDuration: 14 as const, selectedStrategyIndex: 1, selectedIntlStrategyIndex: 1, maxTestBudget };
  const payload = buildBriefPdfPayload({
    ...common, generatedAt: "2026-11-02T00:00:00.000Z", brandName: "Ada Wear", productName: PRODUCT, productPrice: undefined,
    goal: "Drive Website Sales", generatedCopy: copy, selectedCta: "Shop Now", gatewayInsight: null, isNewLaunch: false,
  });
  return {
    payload,
    // Each render carries a fresh CSP nonce; everything else must match.
    html: (await buildBriefHTML(payload)).replace(/nonce-[A-Za-z0-9+/=]+/g, "nonce-X").replace(/nonce="[^"]*"/g, 'nonce="X"'),
    text: buildBriefText({ ...common, generatedCopy: copy, selectedCta: "Shop Now", goal: "Drive Website Sales", gatewayInsight: null }),
    plan: budgetPlanFor({ aiInsights: ai, storeInsights, maxTestBudget, selectedDuration }),
    markup: renderToStaticMarkup(
      <BriefStep
        generatedCopy={copy} copiedField={null} onCopy={() => {}} selectedCta="Shop Now" storeInsights={storeInsights} aiInsights={ai}
        loadingAiInsights={false} goal="Drive Website Sales" selectedStrategyIndex={1} setSelectedStrategyIndex={() => {}}
        selectedDuration={selectedDuration} setSelectedDuration={() => {}} isDownloadingPdf={false} onDownloadPdf={() => {}}
        onCopyBrief={() => {}} onCreateNew={() => {}} maxTestBudget={maxTestBudget} setMaxTestBudget={() => {}}
      />,
    ),
  };
};

const cases: Array<[string, StoreInsights]> = [
  ["a matched product in a 1,000-product catalog", snapshot()],
  ["a product missing from the catalog", snapshot({ includeProduct: false })],
  ["no storefront analytics", snapshot({ analytics: false })],
  ["no pre-spend section", snapshot({ prespend: false })],
  ["a domestic-only US store", snapshot({ country: "US", currency: "USD", locations: [{ city: "Austin", country: "US", percentage: 70 }, { city: "Dallas", country: "US", percentage: 30 }] })],
  ["an empty catalog", snapshot({ products: 0 })],
];

describe("bounded brief evidence (task 9)", () => {
  it.each(cases)("renders a brief identically from the bounded evidence: %s", async (_, full) => {
    const before = stored(full);
    const after = stored(boundBriefEvidence(full, PRODUCT));
    for (const [peakDays, maxTestBudget, duration] of [[[], null, 14], [["Monday"], 280000, 7], [[], 5000, 30]] as const) {
      const ai = insights([...peakDays]);
      const a = await views(before, ai, maxTestBudget, duration);
      const b = await views(after, ai, maxTestBudget, duration);
      expect(b.payload).toEqual(a.payload);
      expect(b.html).toBe(a.html);
      expect(b.text).toBe(a.text);
      expect(b.plan).toEqual(a.plan);
      expect(b.markup).toBe(a.markup);
    }
  });

  it("keeps a brief small: under 8 KB instead of the whole snapshot", () => {
    const full = snapshot();
    const bounded = JSON.stringify(boundBriefEvidence(full, PRODUCT));
    expect(JSON.stringify(full).length).toBeGreaterThan(500_000);
    expect(bounded.length).toBeLessThan(8_000);
  });

  it("keeps only the brief's product and the store-wide out-of-stock count", () => {
    const bounded = boundBriefEvidence(snapshot(), PRODUCT)!;
    expect(bounded.products?.map((p) => p.name)).toEqual([PRODUCT]);
    expect(bounded.catalog).toEqual({ out_of_stock_count: 112 });
    expect(Object.keys(bounded.products![0]).sort()).toEqual([
      "description", "handle", "id", "in_stock", "name", "order_count", "price", "price_less_unit_cost", "tags",
      "unit_cost", "unit_cost_coverage", "unit_cost_currency", "units_sold",
    ]);
  });

  it("keeps the store's identity, which shop redaction matches on", () => {
    expect(boundBriefEvidence(snapshot(), PRODUCT)!.store).toEqual({
      name: "Ada Wear", domain: "adawear.com", myshopify_domain: "ada-wear.myshopify.com", country: "NG", currency: "NGN", currency_symbol: "₦",
    });
  });

  it("is idempotent, and recognises bounded evidence", () => {
    const once = boundBriefEvidence(snapshot(), PRODUCT);
    expect(isBoundedEvidence(once)).toBe(true);
    expect(isBoundedEvidence(snapshot())).toBe(false);
    expect(boundBriefEvidence(once, PRODUCT)).toBe(once);
    expect(boundBriefEvidence(stored(once), "Another product")).toEqual(once);
  });

  it("returns nothing for a missing snapshot", () => {
    expect(boundBriefEvidence(null, PRODUCT)).toBeNull();
    expect(boundBriefEvidence("not a snapshot", PRODUCT)).toBeNull();
  });
});
