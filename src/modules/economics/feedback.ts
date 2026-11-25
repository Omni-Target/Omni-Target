/**
 * Campaign results and what to do next (Phase 4, task 7; architecture/phase-4-economics.md, "Campaign results
 * and feedback"). Pure. Results are converted to the shop's currency with the rate recorded beside each day;
 * only matured days (older than the attribution lag) are judged; the cost per sale gets an exact Poisson
 * interval from the conversion count; the conversion rate gets its own Wilson interval and is never used as a
 * CPA interval.
 */
import { money } from "./money";
import type { EconomicsPolicySettings } from "./policy";
import type { Commitment } from "./portfolio";
import type { AcquisitionEvidence, ProductRecommendation } from "./recommend";
import type { ReasonCode } from "./reasons";
import { poissonBounds, wilsonBounds } from "./stats";

export interface CampaignDay {
  day: string;
  spend: number;
  conversions: number;
  conversion_value: number | null;
  clicks: number | null;
  impressions: number | null;
  /** Shop-currency units per campaign-currency unit, as recorded for that day. */
  fx_to_shop: number;
  fx_source: string;
  /** 0056: the pair (campaign currency → shop currency) and when the rate applied. */
  fx_from?: string;
  fx_to?: string;
  fx_as_of?: string;
}

export interface TrackedCampaign {
  id: string;
  name: string;
  product_ids: number[];
  status: "planned" | "active" | "paused" | "ended";
  currency: string;
  /** In the campaign's currency. */
  daily_budget: number | null;
  /** In the shop's currency. */
  authorised_budget: number | null;
  max_loss: number | null;
  recommendation_run_id: string | null;
  started_on: string | null;
  last_scaled_on: string | null;
  /** 0056: a test, or a diagnostic micro-pilot whose results never prove acquisition or justify scaling. */
  purpose?: "test" | "diagnostic";
  /** As configured on the platform, e.g. "7d_click_1d_view"; sets how long conversions take to mature. */
  attribution_setting?: string;
  results: CampaignDay[];
}

/** Days a conversion may take to be credited, from the campaign's own attribution setting ("7d_click_1d_view" → 7). */
export function attributionLagDays(setting: string | undefined, fallback: number): number {
  const days = [...(setting ?? "").matchAll(/(\d+)\s*d/gi)].map((m) => Number(m[1])).filter((d) => d > 0 && d <= 90);
  return days.length ? Math.max(...days) : fallback;
}

const DAY = 86_400_000;
const dayNumber = (iso: string) => Math.floor(Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso) / DAY);

/** Database rows to typed campaigns (numerics may arrive as strings). */
export function normaliseCampaigns(raw: unknown[]): TrackedCampaign[] {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return (raw as Array<Record<string, unknown>>).map((c) => ({
    id: String(c.id), name: String(c.name), product_ids: (c.product_ids as unknown[]).map(Number), status: c.status as TrackedCampaign["status"],
    currency: String(c.currency), daily_budget: n(c.daily_budget), authorised_budget: n(c.authorised_budget), max_loss: n(c.max_loss),
    recommendation_run_id: (c.recommendation_run_id as string | null) ?? null, started_on: (c.started_on as string | null) ?? null,
    last_scaled_on: (c.last_scaled_on as string | null) ?? null,
    purpose: c.purpose === "diagnostic" ? "diagnostic" : "test",
    attribution_setting: typeof c.attribution_setting === "string" ? c.attribution_setting : undefined,
    results: ((c.results as Array<Record<string, unknown>>) ?? []).map((r) => ({
      day: String(r.day), spend: Number(r.spend), conversions: Number(r.conversions), conversion_value: n(r.conversion_value), clicks: n(r.clicks),
      impressions: n(r.impressions), fx_to_shop: Number(r.fx_to_shop), fx_source: String(r.fx_source),
      ...(r.fx_from ? { fx_from: String(r.fx_from), fx_to: String(r.fx_to), fx_as_of: String(r.fx_as_of) } : {}),
    })),
  }));
}

export interface CampaignMeasure {
  currency: string;
  days: number;
  matured_days: number;
  immature_days: number;
  /** All spend so far, shop currency (spend is known at once; conversions are not). */
  spend: number;
  conversions: number;
  matured_spend: number;
  matured_conversions: number;
  cpa: number | null;
  /** Exact Poisson bounds on the conversion count turned into CPA bounds; null upper bound with no sale. */
  cpa_lower: number | null;
  cpa_upper: number | null;
  /** Conversions ÷ clicks over matured days with clicks, and its Wilson bounds: a rate, never a CPA interval. */
  conversion_rate: { value: number; lower: number; upper: number; clicks: number } | null;
  /** The exchange rates used, as recorded, with their pair and when they applied. */
  fx: Array<{ rate: number; source: string; days: number; from?: string; to?: string; as_of?: string }>;
  /** The attribution wait used, in days. */
  attribution_lag_days: number;
  /** Policy version 3: the confidence behind cpa_lower (pausing) and cpa_upper (scaling). */
  confidence?: { pause: number; scale: number };
}

export function measureCampaign(days: CampaignDay[], shopCurrency: string, asOf: string, policy: EconomicsPolicySettings, sinceDays?: number,
  lagDays: number = policy.attribution_lag_days): CampaignMeasure {
  const m = money(shopCurrency);
  const today = dayNumber(asOf);
  const lastMatured = today - lagDays;
  const window = sinceDays === undefined ? days : days.filter((d) => dayNumber(d.day) > today - sinceDays);
  const matured = window.filter((d) => dayNumber(d.day) <= lastMatured);
  const toShop = (d: CampaignDay) => m.up(d.spend * d.fx_to_shop);
  const spendAll = window.reduce((t, d) => t + toShop(d), 0);
  const spendMatured = matured.reduce((t, d) => t + toShop(d), 0);
  const conversions = window.reduce((t, d) => t + d.conversions, 0);
  const maturedConversions = matured.reduce((t, d) => t + d.conversions, 0);
  // Each decision uses its own confidence (policy version 3); before that, both use decision_confidence.
  const pauseBounds = poissonBounds(maturedConversions, policy.pause_confidence ?? policy.decision_confidence);
  const scaleBounds = policy.scale_confidence === undefined ? pauseBounds : poissonBounds(maturedConversions, policy.scale_confidence);
  const withClicks = matured.filter((d) => d.clicks !== null);
  const clicks = withClicks.reduce((t, d) => t + (d.clicks ?? 0), 0);
  const clickConversions = withClicks.reduce((t, d) => t + d.conversions, 0);
  const fx = new Map<string, CampaignMeasure["fx"][number]>();
  for (const d of window) {
    const k = `${d.fx_to_shop}|${d.fx_source}|${d.fx_as_of ?? ""}`;
    fx.set(k, { rate: d.fx_to_shop, source: d.fx_source, days: (fx.get(k)?.days ?? 0) + 1,
      ...(d.fx_from ? { from: d.fx_from, to: d.fx_to, as_of: d.fx_as_of } : {}) });
  }
  return {
    currency: shopCurrency,
    days: window.length,
    matured_days: matured.length,
    immature_days: window.length - matured.length,
    spend: m.major(spendAll),
    conversions,
    matured_spend: m.major(spendMatured),
    matured_conversions: maturedConversions,
    cpa: maturedConversions > 0 ? m.major(m.up(m.major(spendMatured) / maturedConversions)) : null,
    cpa_lower: matured.length ? m.major(m.down(m.major(spendMatured) / pauseBounds.upper)) : null,
    cpa_upper: maturedConversions > 0 ? m.major(m.up(m.major(spendMatured) / scaleBounds.lower)) : null,
    conversion_rate: clicks > 0 && clickConversions <= clicks ? { value: clickConversions / clicks, clicks,
      ...wilsonBounds(clickConversions, clicks, policy.decision_confidence) } : null,
    fx: [...fx.values()],
    attribution_lag_days: lagDays,
    ...(policy.scale_confidence !== undefined ? { confidence: { pause: policy.pause_confidence as number, scale: policy.scale_confidence } } : {}),
  };
}

/** A product's acquisition evidence: its single-product campaigns' matured results in the acquisition window. */
export function acquisitionFromCampaigns(campaigns: TrackedCampaign[], productId: number, shopCurrency: string, asOf: string,
  policy: EconomicsPolicySettings): AcquisitionEvidence | null {
  const own = campaigns.filter((c) => c.product_ids.length === 1 && c.product_ids[0] === productId);
  // Tests count; a diagnostic micro-pilot counts only when there is nothing else, and then never proves acquisition.
  const tests = own.filter((c) => c.purpose !== "diagnostic");
  const used = tests.some((c) => c.results.length) ? tests : own;
  const days = used.flatMap((c) => c.results);
  if (!days.length) return null;
  const lag = Math.max(...used.map((c) => attributionLagDays(c.attribution_setting, policy.attribution_lag_days)));
  const measure = measureCampaign(days, shopCurrency, asOf, policy, policy.acquisition_window_days, lag);
  if (measure.days === 0) return null;
  return { matured_conversions: measure.matured_conversions, matured_spend: measure.matured_spend, cpa: measure.cpa,
    cpa_lower: measure.cpa_lower, cpa_upper: measure.cpa_upper, immature_days: measure.immature_days,
    ...(used.every((c) => c.purpose === "diagnostic") ? { diagnostic_only: true } : {}) };
}

/** What running and planned campaigns will still spend in the period, in the shop's currency; null when it cannot be converted. */
export function commitmentsFromCampaigns(campaigns: TrackedCampaign[], shopCurrency: string, policy: EconomicsPolicySettings): Array<Commitment & { amount: number | null }> {
  const m = money(shopCurrency);
  return campaigns.filter((c) => c.status === "active" || c.status === "planned").map((c) => {
    const spent = c.results.reduce((t, d) => t + m.up(d.spend * d.fx_to_shop), 0);
    const latest = [...c.results].sort((a, b) => a.day.localeCompare(b.day)).at(-1);
    const rate = c.currency === shopCurrency ? 1 : latest?.fx_to_shop ?? null;
    const byDaily = c.daily_budget !== null && rate !== null ? m.up(c.daily_budget * rate * policy.portfolio_period_days) : null;
    const remaining = c.authorised_budget !== null ? Math.max(0, m.down(c.authorised_budget) - spent) : null;
    const amount = remaining !== null && byDaily !== null ? Math.min(remaining, byDaily) : remaining ?? byDaily;
    return { campaign_id: c.id, product_ids: c.product_ids, amount: amount === null ? null : m.major(amount) };
  });
}

export type FeedbackAction = "NOT_RUNNING" | "STOP" | "PAUSE_FOR_INVENTORY" | "REDUCE_FOR_INVENTORY" | "RECALCULATE" | "WAIT"
  | "PAUSE_REVISE" | "SCALE" | "HOLD_OPTIMISE" | "CONTINUE";

export interface CampaignFeedback {
  campaign_id: string;
  action: FeedbackAction;
  reasons: ReasonCode[];
  measure: CampaignMeasure;
  /** The thresholds judged against, in the shop's currency, per purchase as the ad platform counts it. */
  break_even_cpa: number | null;
  target_cpa: number | null;
  /**
   * Policy version 2, kept apart from the ad-reported figures above: what each order actually PAID cost, and its
   * break-even. Equal to the reported CPA when purchases are counted when paid; reported CPA ÷ the paid share when
   * counted when placed; null while the merchant has not confirmed how the platform counts purchases.
   */
  paid_orders?: { purchase_event_basis: "placed" | "paid" | "unconfirmed"; cpa_per_paid_order: number | null; break_even_cpa_per_paid_order: number | null };
  cumulative_loss: number;
  loss_limit: number | null;
  /** The daily budget to run next, in the campaign's currency; 0 to stop or pause; null to leave as is. */
  next_daily_budget: number | null;
  explanation: string[];
}

export function evaluateCampaign(args: {
  campaign: TrackedCampaign;
  shopCurrency: string;
  /** The current recommendation of each product the campaign covers. */
  current: ProductRecommendation[];
  /** The recommendations that authorised it, when recorded. */
  atLaunch?: ProductRecommendation[];
  /** The merchant's daily limit, in the shop's currency. */
  dailyLimit?: number | null;
  policy: EconomicsPolicySettings;
  asOf: string;
}): CampaignFeedback {
  const { campaign, policy } = args;
  const m = money(args.shopCurrency);
  const measure = measureCampaign(campaign.results, args.shopCurrency, args.asOf, policy, undefined,
    attributionLagDays(campaign.attribution_setting, policy.attribution_lag_days));
  const reasons: ReasonCode[] = [];
  const explanation: string[] = [];
  // A campaign selling several products is judged against the least forgiving of them.
  const bes = args.current.map((r) => r.economics.break_even_cpa).filter((v): v is number => v !== null);
  const targets = args.current.map((r) => r.economics.target_cpa).filter((v): v is number => v !== null);
  const be = bes.length === args.current.length && bes.length ? Math.min(...bes) : null;
  const target = targets.length === args.current.length && targets.length ? Math.min(...targets) : null;
  const latestFx = [...campaign.results].sort((a, b) => a.day.localeCompare(b.day)).at(-1)?.fx_to_shop ?? (campaign.currency === args.shopCurrency ? 1 : null);
  const toCampaignCurrency = (shopAmount: number) => (latestFx ? shopAmount / latestFx : null);
  const loss = m.major(m.up(measure.spend) - m.down(measure.conversions * (be ?? 0)));
  // The paid-order view, for a single-product campaign under policy version 2.
  const only = args.current.length === 1 ? args.current[0].economics : null;
  const paidOrders = only?.purchase_event_basis === undefined || only === null ? undefined : {
    purchase_event_basis: only.purchase_event_basis,
    cpa_per_paid_order: measure.cpa === null || only.purchase_event_basis === "unconfirmed" ? null
      : only.purchase_event_basis === "paid" ? measure.cpa
      : (only.rates.paid_share.value ?? 0) > 0 ? m.major(m.up(measure.cpa / (only.rates.paid_share.value as number))) : null,
    break_even_cpa_per_paid_order: only.break_even_cpa_per_paid_order ?? null,
  };
  const base = { campaign_id: campaign.id, measure, break_even_cpa: be, target_cpa: target, cumulative_loss: loss, loss_limit: campaign.max_loss,
    ...(paidOrders ? { paid_orders: paidOrders } : {}) };
  const done = (action: FeedbackAction, next: number | null): CampaignFeedback => ({ ...base, action, reasons, next_daily_budget: next, explanation });

  if (campaign.status !== "active") return done("NOT_RUNNING", null);

  // 1. The authorised loss limit is final.
  if (campaign.max_loss !== null && loss >= campaign.max_loss) {
    reasons.push("LOSS_LIMIT_REACHED");
    explanation.push(`Spend ${measure.spend} less ${measure.conversions} sales × break-even ${be} leaves a loss of ${loss}, at or above the authorised ${campaign.max_loss}.`);
    return done("STOP", 0);
  }

  // 2. The product itself changed: unviable or blocked now pauses; anything else material recalculates.
  const now = args.current;
  if (now.some((r) => r.verdict === "BLOCKED" || r.verdict === "DO_NOT_LAUNCH")) {
    reasons.push(...new Set(now.flatMap((r) => (r.verdict === "BLOCKED" || r.verdict === "DO_NOT_LAUNCH" ? r.reasons : []))));
    explanation.push("A product in the campaign can no longer be advertised profitably or at all.");
    return done("PAUSE_REVISE", 0);
  }
  const material = (a: number | null, b: number | null) => a !== null && b !== null && b !== 0 && Math.abs(a - b) / Math.abs(b) > policy.material_change_threshold;
  const changed = (args.atLaunch ?? []).filter((then) => {
    const cur = now.find((r) => r.product_id === then.product_id);
    if (!cur) return false;
    return cur.verdict === "INSUFFICIENT_DATA" || material(cur.economics.price_per_unit, then.economics.price_per_unit)
      || material(cur.economics.unit_cost_per_unit, then.economics.unit_cost_per_unit) || material(cur.economics.break_even_cpa, then.economics.break_even_cpa);
  });
  if (changed.length || be === null || target === null) {
    reasons.push("ECONOMICS_CHANGED");
    explanation.push("Price, cost or break-even moved materially since launch, or an input is now missing: recalculate before changing spend.");
    return done("RECALCULATE", null);
  }

  // 3. Stock must cover the orders the current budget is expected to bring.
  const forAds = now.reduce((t, r) => t + (r.budget.inventory?.units_for_ads ?? (r.notes.includes("INVENTORY_UNTRACKED") ? Infinity : 0)), 0);
  const unitsPerOrder = Math.max(1, ...now.map((r) => r.economics.units_per_order));
  const cpaBasis = measure.cpa !== null && measure.cpa > 0 ? Math.min(measure.cpa, target) : target;
  const dailyShop = campaign.daily_budget !== null && latestFx !== null ? campaign.daily_budget * latestFx : null;
  if (forAds !== Infinity) {
    if (forAds <= 0) {
      reasons.push("INVENTORY_LIMITED");
      explanation.push("No stock is left for advertising after reserving organic demand.");
      return done("PAUSE_FOR_INVENTORY", 0);
    }
    if (dailyShop !== null && (dailyShop * policy.inventory_cover_days / cpaBasis) * unitsPerOrder > forAds) {
      const affordable = m.down((forAds / unitsPerOrder) * cpaBasis / policy.inventory_cover_days);
      const next = toCampaignCurrency(m.major(affordable));
      reasons.push("INVENTORY_LIMITED");
      explanation.push(`${forAds} units are left for advertising; at ${cpaBasis} per sale the daily budget must fall to cover ${policy.inventory_cover_days} days.`);
      return done("REDUCE_FOR_INVENTORY", next === null ? null : m.major(m.down(next)));
    }
  }

  // 4. Too early to judge.
  if (measure.matured_days === 0 || (measure.matured_spend < policy.min_judgement_spend_multiple * be && measure.matured_conversions < policy.min_scale_conversions)) {
    reasons.push(measure.matured_days === 0 ? "ATTRIBUTION_IMMATURE" : "INSUFFICIENT_CONVERSION_EVIDENCE");
    if (measure.immature_days > 0 && measure.matured_days > 0) reasons.push("ATTRIBUTION_IMMATURE");
    explanation.push(`Matured spend ${measure.matured_spend} with ${measure.matured_conversions} sales: not yet enough to judge against break-even ${be}.`);
    return done("WAIT", null);
  }

  // 5. Confidently above break-even (no sales counts: the lowest plausible cost per sale is spend ÷ the upper count).
  if (measure.cpa_lower !== null && measure.cpa_lower > be) {
    reasons.push("CPA_ABOVE_BREAK_EVEN");
    explanation.push(`Even the lowest plausible cost per sale, ${measure.cpa_lower}, is above break-even ${be}.`);
    return done("PAUSE_REVISE", 0);
  }

  // 6. Scale gradually, only on matured evidence clearly inside break-even, and never from a diagnostic micro-pilot.
  if (campaign.purpose === "diagnostic") {
    reasons.push("MICRO_PILOT_DIAGNOSTIC");
    explanation.push("A diagnostic micro-pilot shows traffic, engagement and first sales; it is never scaled. Run a controlled test to prove acquisition.");
    return done(measure.cpa !== null && measure.cpa > (target as number) ? "HOLD_OPTIMISE" : "CONTINUE", null);
  }
  if (measure.cpa !== null && measure.cpa <= target && measure.cpa_upper !== null && measure.cpa_upper <= be
    && measure.matured_conversions >= policy.min_scale_conversions && campaign.daily_budget !== null) {
    const sinceScale = campaign.last_scaled_on ? dayNumber(args.asOf) - dayNumber(campaign.last_scaled_on) : Infinity;
    if (sinceScale < policy.scale_interval_days) {
      reasons.push("SCALE_INTERVAL_NOT_ELAPSED");
      explanation.push(`Last increased ${sinceScale} day(s) ago; the policy waits ${policy.scale_interval_days}.`);
      return done("CONTINUE", null);
    }
    let next = campaign.daily_budget * (1 + policy.scale_step);
    const caps: number[] = [];
    if (args.dailyLimit != null) { const c = toCampaignCurrency(args.dailyLimit); if (c !== null) caps.push(c); }
    if (forAds !== Infinity) { const c = toCampaignCurrency((forAds / unitsPerOrder) * target / policy.inventory_cover_days); if (c !== null) caps.push(c); }
    next = Math.min(next, ...caps);
    const nextMinor = money(campaign.currency).down(next);
    if (nextMinor <= money(campaign.currency).down(campaign.daily_budget)) {
      reasons.push("MERCHANT_LIMIT_BINDING");
      explanation.push("Results support more spend, but the merchant's daily limit or the stock does not.");
      return done("CONTINUE", null);
    }
    explanation.push(`${measure.matured_conversions} matured sales at ${measure.cpa} (at most ${measure.cpa_upper}) against target ${target} and break-even ${be}: increase by at most ${policy.scale_step * 100}%.`);
    return done("SCALE", money(campaign.currency).major(nextMinor));
  }

  // 7. Above target but not confidently above break-even: keep the budget and improve the campaign.
  if (measure.cpa === null || measure.cpa > target || (measure.cpa_upper !== null && measure.cpa_upper > be)) {
    reasons.push(measure.cpa !== null && measure.cpa > target ? "CPA_ABOVE_TARGET" : "INSUFFICIENT_CONVERSION_EVIDENCE");
    explanation.push(`Cost per sale ${measure.cpa ?? "not yet measured"} against target ${target} and break-even ${be}: hold the budget and optimise.`);
    return done("HOLD_OPTIMISE", null);
  }

  reasons.push("INSUFFICIENT_CONVERSION_EVIDENCE");
  explanation.push(`On target, with ${measure.matured_conversions} matured sales; scaling waits for ${policy.min_scale_conversions}.`);
  return done("CONTINUE", null);
}
