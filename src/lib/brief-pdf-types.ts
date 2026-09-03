/**
 * Shared brief-PDF types + pure helpers, dependency-free so both client code
 * (e.g. the brief modal) and the server-side HTML/PDF renderer can use them.
 */

export interface CreativeHook {
  angle: string;
  visual_cue: string;
  on_screen_text: string;
  primary_text_hook: string;
}

export interface AdvantagePlusGuidance {
  campaign_type:
    | "Advantage+ Shopping Campaign (ASC)"
    | "Manual Sales with Advantage+ Audience";
  optimization_event: "AddToCart" | "InitiateCheckout" | "Purchase";
  optimization_reasoning: string;
  seed_audience_suggestions: {
    age_min: number;
    age_max: number;
    gender: "All" | "Men" | "Women";
    demographic_justification: string;
    seed_interests: string[];
  };
}

export interface ImplementationStep {
  level: "Campaign level" | "Ad set level" | "Ad level";
  title: string;
  instructions: string;
}

export interface CampaignBriefPayload {
  id: string;
  product_title: string;
  product_url: string;
  anchor_sku: string;
  strategy_insight: string;
  creative_direction: string;
  copy: {
    headline: string;
    primary_text: string;
    link_description: string;
    call_to_action: string;
    copywriter_note: string;
  };
  creative_hooks: CreativeHook[];
  advantage_plus_guidance: AdvantagePlusGuidance;
  budget_and_strategy: {
    daily_budget_currency: string;
    daily_budget_amount: number;
    duration_days: number;
    total_test_spend: number;
    ad_sets_count: number;
    revenue_signal_monthly: number;
    aov_signal: number;
    strategy_context: string;
    launch_timing: string;
    best_days_to_run: string[];
  };
  pre_launch_checklist: {
    out_of_stock_count: number;
    warnings: string[];
  };
  implementation_steps: ImplementationStep[];
}

export interface BriefPDFParams {
  id?: string;
  brandName: string;
  productName: string;
  productPrice?: number;
  productUrl?: string;
  campaignGoal: string;
  copy: {
    headline: string;
    primaryText: string;
    description: string;
    cta: string;
    copywriterNote: string;
  };
  creative_hooks?: CreativeHook[];
  advantage_plus_guidance?: AdvantagePlusGuidance;
  // Legacy targeting field preserved as optional for historical briefs
  targeting?: {
    locations?: { name?: string; city?: string; source?: string }[];
    domestic_locations?: { name?: string; city?: string; source?: string }[];
    international_locations?: { name?: string; city?: string; source?: string }[];
    domestic_budget_formatted?: string;
    international_budget_formatted?: string;
    overseas_demand?: string[];
    age_min?: number;
    age_max?: number;
    gender?: string;
    interests?: string[];
    behaviours?: string[];
    age_reasoning?: string;
    interest_reasoning?: string;
  };
  budget: {
    recommended_daily?: number;
    recommended_duration_days?: number;
    reasoning?: string;
    currency?: string;
    currency_symbol?: string;
    tier?: string;
    ad_sets?: number;
    optimization_event?: {
      event: string;
      reasoning: string;
    };
    breakdown?: {
      revenue_based: number;
      aov_based: number;
    };
    goal_adjusted_daily?: number;
    goal_label?: string;
    international_daily?: number;
    international_tier?: string;
    international_budget_formatted?: string;
  };
  timing: {
    peak_days?: string[];
    launch_recommendation?: string;
    reasoning?: string;
  };
  warnings: string[];
  generatedAt: string;
  gatewayInsight?: {
    currentProductClassification: string;
    currentProductName: string;
    currentProductImage: string;
    bestsellerName: string;
    topGatewayName: string;
    isBestsellerGateway: boolean;
    currentProductVelocity: number;
    currentProductRepeatRate: number;
    storeAov: number;
    storeBaseFtb: number;
  };
  isNewLaunch?: boolean;
  implementation_steps?: ImplementationStep[];
  pre_launch_checklist?: {
    out_of_stock_count: number;
    warnings: string[];
  };
}

export function pdfFileName(params: BriefPDFParams): string {
  const cleanName = (params.productName || "campaign")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `omni-target-brief-${cleanName || "campaign"}.pdf`;
}
