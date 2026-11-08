/**
 * Runtime validation for the client-supplied PDF brief payload (Phase S0.5 — SEC-06).
 *
 * /api/campaigns/pdf receives the brief as JSON from the browser and renders
 * it to HTML (preview iframe) and to a PDF (headless Chromium). This module:
 *   1. bounds the overall payload (size, depth, string/array lengths) so a
 *      request cannot balloon the renderer, and
 *   2. enforces types for every field the template interpolates as a number
 *      or computes with, plus constrained formats for currency codes, currency
 *      symbols and URLs.
 * Free-text strings stay permissive (bounded) — HTML safety for them comes
 * from escaping and the document Content-Security-Policy in the template, not
 * from rejecting legitimate copy.
 */
import { z } from "zod";
import type { BriefPDFParams } from "./brief-pdf-types";

export const MAX_PDF_BODY_BYTES = 512 * 1024;

const LIMITS = { depth: 12, string: 20_000, array: 500, keys: 300, nodes: 50_000 };

/** Structural bounds for arbitrary JSON (applied before schema parsing). */
export function checkBoundedJson(value: unknown): string | null {
  let nodes = 0;
  const walk = (v: unknown, depth: number, path: string): string | null => {
    nodes += 1;
    if (nodes > LIMITS.nodes) return "payload too large";
    if (depth > LIMITS.depth) return `${path || "root"}: nested too deeply`;
    if (typeof v === "string") return v.length > LIMITS.string ? `${path}: string too long` : null;
    if (typeof v === "number") return Number.isFinite(v) ? null : `${path}: invalid number`;
    if (v === null || typeof v === "boolean") return null;
    if (Array.isArray(v)) {
      if (v.length > LIMITS.array) return `${path}: too many items`;
      for (let i = 0; i < v.length; i += 1) {
        const err = walk(v[i], depth + 1, `${path}[${i}]`);
        if (err) return err;
      }
      return null;
    }
    if (typeof v === "object") {
      const keys = Object.keys(v as object);
      if (keys.length > LIMITS.keys) return `${path || "root"}: too many keys`;
      for (const key of keys) {
        const err = walk((v as Record<string, unknown>)[key], depth + 1, path ? `${path}.${key}` : key);
        if (err) return err;
      }
      return null;
    }
    return `${path}: unsupported value`;
  };
  return walk(value, 0, "");
}

const text = (max: number) => z.string().max(max);
const optText = (max: number) => z.string().max(max).optional();
const optNum = z.number().nullable().optional();
const amount = z.number().min(0).max(1e12).nullable().optional();

const httpUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

const location = z.looseObject({ name: optText(300), city: optText(300), source: optText(100) });

const briefPdfParamsSchema = z.looseObject({
  storeCountry: optText(100),
  id: optText(100),
  brandName: text(300),
  productName: text(500),
  productPrice: amount,
  productUrl: httpUrl.optional(),
  campaignGoal: text(200),
  copy: z.looseObject({
    headline: text(1000),
    primaryText: text(10_000),
    description: text(2000),
    cta: text(100),
    copywriterNote: text(10_000),
  }),
  creative_hooks: z
    .array(
      z.looseObject({
        angle: text(500),
        visual_cue: text(4000),
        on_screen_text: text(4000),
        primary_text_hook: text(4000),
      }),
    )
    .max(20)
    .optional(),
  advantage_plus_guidance: z
    .looseObject({
      campaign_type: text(200),
      optimization_event: text(50),
      optimization_reasoning: text(10_000),
      seed_audience_suggestions: z.looseObject({
        age_min: z.number().min(0).max(120),
        age_max: z.number().min(0).max(120),
        gender: text(20),
        demographic_justification: text(10_000),
        seed_interests: z.array(text(300)).max(100),
      }),
    })
    .optional(),
  targeting: z
    .looseObject({
      locations: z.array(location).max(100).optional(),
      domestic_locations: z.array(location).max(100).optional(),
      international_locations: z.array(location).max(100).optional(),
      domestic_budget_formatted: optText(200),
      international_budget_formatted: optText(200),
      overseas_demand: z.array(text(300)).max(100).optional(),
      age_min: z.number().min(0).max(120).optional(),
      age_max: z.number().min(0).max(120).optional(),
      gender: optText(20),
      interests: z.array(text(300)).max(100).optional(),
      behaviours: z.array(text(300)).max(100).optional(),
      age_reasoning: optText(10_000),
      interest_reasoning: optText(10_000),
    })
    .optional(),
  budget: z.looseObject({
    calculation: z
      .looseObject({
        product_price: optNum,
        effective_price: optNum,
        revenue_30d: optNum,
        product_revenue_30d: optNum,
        baseline_test_usd: optNum,
        baseline_duration_days: optNum,
        baseline_daily: optNum,
        price_guardrail_daily: optNum,
        daily_before_strategy: optNum,
        fx: z
          .looseObject({
            currency: optText(10),
            rate: z.number().min(0).max(1e9),
            source: optText(100),
            fetched_at: z.string().max(64).nullable().optional(),
          })
          .optional(),
      })
      .optional(),
    recommended_daily: amount,
    recommended_duration_days: z.number().min(0).max(366).optional(),
    reasoning: optText(20_000),
    currency: z.string().regex(/^[A-Z]{3}$/, "must be an ISO currency code").optional(),
    currency_symbol: z.string().max(8).regex(/^[^<>"'&]*$/, "unsafe currency symbol").optional(),
    tier: optText(100),
    ad_sets: z.number().min(0).max(100).optional(),
    optimization_event: z.looseObject({ event: text(100), reasoning: text(10_000) }).optional(),
    breakdown: z.looseObject({ revenue_based: optNum, aov_based: optNum }).optional(),
    goal_adjusted_daily: amount,
    goal_label: optText(200),
    international_daily: amount,
    international_tier: optText(100),
    international_budget_formatted: optText(200),
    international_duration_days: z.number().min(0).max(366).optional(),
  }),
  timing: z.looseObject({
    peak_days: z.array(text(40)).max(14).optional(),
    launch_recommendation: optText(2000),
    reasoning: optText(10_000),
  }),
  warnings: z.array(text(4000)).max(100),
  generatedAt: text(100),
  gatewayInsight: z
    .looseObject({
      productDecision: z
        .looseObject({
          first_order_count: optNum,
          identified_first_orders: optNum,
          later_order_count: optNum,
          follow_up_60d: z
            .looseObject({
              eligible_first_order_buyers: optNum,
              buyers_with_another_order: optNum,
              repeat_rate: optNum,
            })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
      currentProductClassification: optText(200),
      currentProductName: optText(500),
      currentProductImage: httpUrl.nullable().optional(),
      bestsellerName: optText(500),
      topGatewayName: optText(500),
      isBestsellerGateway: z.boolean().nullable().optional(),
      currentProductVelocity: optNum,
      currentProductRepeatRate: optNum,
      storeAov: optNum,
      storeBaseFtb: optNum,
      firstTimeBuyerRatio: optNum,
      firstTimeBuyerCount: optNum,
      uniqueCustomerCount: optNum,
      orderCount: optNum,
      unitsSold: optNum,
      revenue: optNum,
    })
    .nullable()
    .optional(),
  isNewLaunch: z.boolean().optional(),
  implementation_steps: z
    .array(z.looseObject({ level: text(100), title: text(500), instructions: text(10_000) }))
    .max(20)
    .optional(),
  pre_launch_checklist: z
    .looseObject({ out_of_stock_count: z.number().min(0).max(1e6), warnings: z.array(text(4000)).max(100) })
    .optional(),
  decisionEvidence: z
    .looseObject({
      analytics_window_days: optNum,
      recent_funnel: z
        .looseObject({
          window_days: optNum,
          sessions: optNum,
          cart_sessions: optNum,
          checkout_sessions: optNum,
          completed_checkout_sessions: optNum,
          checkout_conversion_rate: optNum,
        })
        .nullable()
        .optional(),
      historical_conversion_rate: optNum,
      historical_cart_to_checkout_rate: optNum,
      historical_cart_to_order_rate: optNum,
      unit_cost: optNum,
      price_less_unit_cost: optNum,
    })
    .optional(),
});

export type PdfParamsResult = { ok: true; params: BriefPDFParams } | { ok: false; error: string };

/** Validate an already-parsed JSON body. Errors name a field path, never echo values. */
export function parseBriefPdfParams(body: unknown): PdfParamsResult {
  const structural = checkBoundedJson(body);
  if (structural) return { ok: false, error: structural };
  const parsed = briefPdfParamsSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? issue.path.join(".") : "body";
    return { ok: false, error: `${path}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, params: parsed.data as unknown as BriefPDFParams };
}
