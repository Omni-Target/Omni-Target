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
  tier?: string;
  currency: string;
  currency_symbol?: string;
  recommended_daily?: number;
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
}

export interface AiTargeting {
  locations?: Array<{ name?: string; city?: string; source?: string }>;
  domestic_locations?: Array<{ name?: string; city?: string; source?: string }>;
  international_locations?: Array<{ name?: string; city?: string; source?: string }>;
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
  gateway_classification?: string;
}

export interface StoreInsights {
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
