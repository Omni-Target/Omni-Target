import type {
  CreativeHook,
  AdvantagePlusGuidance,
  ImplementationStep,
} from "@/lib/brief-pdf-types";

export type { CreativeHook, AdvantagePlusGuidance, ImplementationStep };

export interface GeneratedCopy {
  headline: string;
  primaryText: string;
  description: string;
  cta: string;
  copywriterNote: string;
}

export interface BudgetStrategy {
  label: string;
  daily: number;
  total_daily: number;
  description: string;
}

export interface AiBudget {
  calculation?: import("@/lib/budget-evidence").BudgetCalculation;
  tier?: string;
  currency: string;
  currency_symbol?: string;
  recommended_daily?: number;
  recommended_duration_days?: number;
  reasoning: string;
  ad_sets?: number;
  optimization_event?: { event: string; reasoning: string };
  breakdown?: {
    goal_multipliers?: Record<string, number>;
    revenue_based?: number;
    aov_based?: number;
  };
  strategies?: BudgetStrategy[];
  international_strategies?: BudgetStrategy[];
  international_recommended_daily?: number;
  international_duration_days?: number;
}

export interface AiTargeting {
  locations?: Array<{ name?: string; city?: string; country?: string; market_type?: string; source?: string }>;
  domestic_locations?: Array<{ name?: string; city?: string; country?: string; market_type?: string; source?: string }>;
  international_locations?: Array<{ name?: string; city?: string; country?: string; market_type?: string; source?: string }>;
  domestic_budget_formatted?: string;
  international_budget_formatted?: string;
  overseas_demand?: string[];
  age_min?: number;
  age_max?: number;
  age_reasoning?: string;
  gender?: string;
  gender_reasoning?: string;
  interests?: string[];
  interest_reasoning?: string;
  behaviours?: string[];
}

export interface AiInsights {
  error?: string;
  generation_status?: "generated" | "fallback";
  creative_hooks?: CreativeHook[];
  advantage_plus_guidance?: AdvantagePlusGuidance;
  implementation_steps?: ImplementationStep[];
  targeting?: AiTargeting;
  budget?: AiBudget;
  timing?: {
    peak_days?: string[];
    launch_recommendation?: string;
    reasoning?: string;
  };
  warnings?: string[];
}

export interface StoreProduct {
  in_stock?: boolean;
  id?: string | number;
  name?: string;
  handle?: string;
  description?: string;
  tags?: string[];
  price?: number;
  image_url?: string;
  revenue?: number;
  units_sold?: number;
  order_count?: number;
  order_velocity?: number;
  repeat_purchase_rate?: number;
  first_time_buyer_ratio?: number;
  first_time_buyer_count?: number;
  unique_customer_count?: number;
  gateway_classification?: string;
  product_decision?: import("@/lib/store-data").ProductDecisionEvidence;
  unit_cost?: number | null;
  unit_cost_currency?: string;
  unit_cost_coverage?: "complete" | "partial" | "missing";
  price_less_unit_cost?: number | null;
  catalog_claims?: import("@/lib/store-data").StoreCatalogClaim[];
}

export interface StoreInsights {
  data_quality?: import("@/lib/store-data").StoreData["data_quality"];
  prespend?: import("@/lib/store-data").StoreData["prespend"];
  store?: {
    name?: string;
    domain?: string;
    country?: string;
    currency?: string;
    currency_symbol?: string;
  };
  orders?: {
    average_order_value?: number;
    orders_last_30_days?: number;
    order_count?: number;
    peak_days?: string[];
    top_locations?: Array<{ city?: string; country?: string; name?: string }>;
  };
  products?: StoreProduct[];
}
