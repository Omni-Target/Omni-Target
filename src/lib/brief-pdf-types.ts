/**
 * Shared brief-PDF types + pure helpers, dependency-free so both client code
 * (e.g. the brief modal) and the server-side HTML/PDF renderer can use them.
 */

export interface BriefPDFParams {
  brandName: string;
  productName: string;
  productUrl?: string;
  campaignGoal: string;
  copy: {
    headline: string;
    primaryText: string;
    description: string;
    cta: string;
    copywriterNote: string;
  };
  targeting: {
    locations?: { name?: string; city?: string; source?: string }[];
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
  };
  timing: {
    peak_days?: string[];
    launch_recommendation?: string;
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
}

export function pdfFileName(params: BriefPDFParams): string {
  return `omni-target-brief-${(params.productName || "campaign")
    .replace(/\s+/g, "-")
    .toLowerCase()}.pdf`;
}
