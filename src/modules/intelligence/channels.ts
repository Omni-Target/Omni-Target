import { parseTrafficSource } from "@/lib/connectors/traffic-source";

/**
 * The referring and landing sites rebuilt from a stored host and UTMs, exactly as attributionSites in
 * src/modules/insights/canonical.ts does (that module loads the AI and Shopify clients, so it is not imported here).
 */
function attributionSites(o: { referrer_host: string | null; utm_source: string | null; utm_medium: string | null }) {
  const query = new URLSearchParams();
  if (o.utm_source) query.set("utm_source", o.utm_source);
  if (o.utm_medium) query.set("utm_medium", o.utm_medium);
  const search = query.toString();
  return { referring_site: o.referrer_host ? `https://${o.referrer_host}/` : null, landing_site: search ? `/?${search}` : null };
}

/**
 * Channel fit (Phase 5, task 5; architecture/phase-5-intelligence.md, "Channel fit"). Which acquisition channels
 * actually sell a product, from its paid orders' recorded journeys (product_channel_evidence, migration 0062), classed
 * with the app's own classifier (parseTrafficSource). Meta is not the default: a product whose sales come from search
 * or email is told so.
 *  - An order without a recorded journey is unknown, never "direct" (the old snapshot counted it as direct).
 *  - Channel fit is unknown when too few orders carry a journey; otherwise each channel is supported, present or absent.
 *  - First-order share separates channels that win new buyers from those that bring buyers back.
 * Pure and versioned; all figures are counts read from Shopify (verified). No channel is inferred from product traits.
 */
export const CHANNEL_RULES = {
  version: 1,
  /** Attributed orders (with a journey) before a scope's mix is used. */
  minAttributedOrders: 20,
  /** Share of orders with a journey below which channel fit is unknown. */
  minCoverage: 0.3,
  /** A channel is supported at this share of attributed orders, and this many orders. */
  supportedShare: 0.2,
  supportedOrders: 10,
} as const;

export type Channel = "meta" | "google" | "tiktok" | "pinterest" | "email" | "direct" | "referral" | "in_person" | "shop_app" | "other_social";
export const CHANNEL_LABELS: Record<Channel, string> = {
  meta: "Meta (Facebook and Instagram)", google: "Google (search and YouTube)", tiktok: "TikTok", pinterest: "Pinterest", email: "Email",
  direct: "Direct visits", referral: "Other websites", in_person: "Point of sale", shop_app: "Shop app", other_social: "Other social",
};

export interface ChannelGroup { referrer_host: string | null; utm_source: string | null; utm_medium: string | null; visit_source: string | null;
  source_name: string | null; journey_known: boolean; orders: number; first_orders: number }
export interface ChannelScopeEvidence { orders: number; journey_known: number; groups: ChannelGroup[] }
export interface ChannelEvidence { as_of: string; window_days: number; store: ChannelScopeEvidence; products: Array<{ product_id: number; channels: ChannelScopeEvidence | null }> }

export interface ChannelShare { channel: Channel; label: string; orders: number; share: number; first_order_share: number; status: "supported" | "present" }
export interface ChannelFit {
  rules_version: number;
  product_id: number;
  scope: "product" | "store" | "none";
  status: "measured" | "unknown";
  /** Paid orders in the scope, and those with a recorded journey (shares are of the latter). */
  orders: number;
  attributed: number;
  coverage: number;
  channels: ChannelShare[];
  meta: { status: "supported" | "present" | "absent" | "unknown"; share: number | null };
  explanation: string;
}

/** The channel of one group of orders; null when Shopify recorded no journey and the sales channel says nothing. */
export function classifyGroup(g: Pick<ChannelGroup, "referrer_host" | "utm_source" | "utm_medium" | "visit_source" | "source_name" | "journey_known">): Channel | null {
  const source = (g.source_name ?? "").toLowerCase();
  if (source === "pos") return "in_person";
  if (source === "shop") return "shop_app";
  if (!g.journey_known && !["instagram", "ig", "facebook", "fb"].includes(source)) return null;
  const sites = attributionSites({ referrer_host: g.referrer_host, utm_source: g.utm_source, utm_medium: g.utm_medium });
  // Shopify's visit source names the referrer when no host or UTM was kept (for example "facebook", "google").
  const referring = sites.referring_site ?? (g.visit_source && !/^(direct|unknown)$/i.test(g.visit_source) ? `https://${g.visit_source.toLowerCase()}.com/` : null);
  const label = parseTrafficSource(referring, sites.landing_site, g.source_name);
  switch (label) {
    case "Facebook": case "Instagram": return "meta";
    case "Google / Search": case "YouTube": return "google";
    case "TikTok": return "tiktok";
    case "Pinterest": return "pinterest";
    case "Email Marketing": return "email";
    case "Point of Sale": return "in_person";
    case "Shopify Shop App": return "shop_app";
    case "Direct / Organic": return "direct";
    case "X / Twitter": case "Reddit": case "Social Bio Link": return "other_social";
    default: return "referral";
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export function channelFit(evidence: ChannelEvidence, productId: number): ChannelFit {
  const own = evidence.products.find((p) => p.product_id === productId)?.channels ?? null;
  const base = { rules_version: CHANNEL_RULES.version, product_id: productId };
  const usable = (s: ChannelScopeEvidence | null) => s !== null && s.journey_known >= CHANNEL_RULES.minAttributedOrders
    && s.journey_known / Math.max(1, s.orders) >= CHANNEL_RULES.minCoverage;
  const scope = usable(own) ? "product" : usable(evidence.store) ? "store" : "none";
  const s = scope === "product" ? own! : scope === "store" ? evidence.store : (own ?? evidence.store);
  const coverage = s.orders > 0 ? round(s.journey_known / s.orders) : 0;
  if (scope === "none") {
    return { ...base, scope, status: "unknown", orders: s.orders, attributed: s.journey_known, coverage, channels: [], meta: { status: "unknown", share: null },
      explanation: `Where buyers come from is not known: ${s.journey_known} of ${s.orders} paid orders carry a recorded visit `
        + `(channel fit needs ${CHANNEL_RULES.minAttributedOrders} and ${CHANNEL_RULES.minCoverage * 100}% of orders). Orders created through the API carry none.` };
  }
  const totals = new Map<Channel, { orders: number; first: number }>();
  let classified = 0;
  for (const g of s.groups) {
    const c = classifyGroup(g);
    if (c === null) continue;
    classified += g.orders;
    const t = totals.get(c) ?? { orders: 0, first: 0 };
    totals.set(c, { orders: t.orders + g.orders, first: t.first + g.first_orders });
  }
  const channels: ChannelShare[] = [...totals.entries()].map(([channel, t]) => {
    const share = round(t.orders / classified);
    return { channel, label: CHANNEL_LABELS[channel], orders: t.orders, share, first_order_share: round(t.first / Math.max(1, t.orders)),
      status: (share >= CHANNEL_RULES.supportedShare && t.orders >= CHANNEL_RULES.supportedOrders ? "supported" : "present") as ChannelShare["status"] };
  }).sort((a, b) => b.orders - a.orders || a.channel.localeCompare(b.channel));
  const meta = channels.find((c) => c.channel === "meta");
  const supported = channels.filter((c) => c.status === "supported");
  const scopeText = scope === "product" ? "the product's own" : "the store's (the product has too few attributed orders)";
  return { ...base, scope, status: "measured", orders: s.orders, attributed: classified, coverage, channels,
    meta: meta ? { status: meta.status, share: meta.share } : { status: "absent", share: 0 },
    explanation: `From ${classified} of ${scopeText} paid orders with a recorded visit: `
      + (supported.length ? `${supported.map((c) => `${c.label} ${Math.round(c.share * 100)}%`).join(", ")} sell it` : "no single channel reaches 20% of sales")
      + (meta && meta.status !== "supported" ? `; Meta has brought ${Math.round(meta.share * 100)}%` : !meta ? "; Meta has brought none so far" : "") + "." };
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const scopeOf = (raw: unknown): ChannelScopeEvidence | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return { orders: n(r.orders), journey_known: n(r.journey_known),
    groups: (Array.isArray(r.groups) ? (r.groups as Record<string, unknown>[]) : []).map((g) => ({ referrer_host: str(g.referrer_host), utm_source: str(g.utm_source),
      utm_medium: str(g.utm_medium), visit_source: str(g.visit_source), source_name: str(g.source_name), journey_known: g.journey_known === true,
      orders: n(g.orders), first_orders: n(g.first_orders) })) };
};
/** product_channel_evidence's JSON (0062) as typed evidence. */
export function normaliseChannelEvidence(raw: unknown): ChannelEvidence {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { as_of: String(r.as_of ?? ""), window_days: n(r.window_days), store: scopeOf(r.store) ?? { orders: 0, journey_known: 0, groups: [] },
    products: (Array.isArray(r.products) ? (r.products as Record<string, unknown>[]) : []).map((p) => ({ product_id: n(p.product_id), channels: scopeOf(p.channels) })) };
}
