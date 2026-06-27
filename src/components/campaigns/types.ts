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
  breakdown?: { goal_multipliers?: Record<string, number> };
  strategies?: BudgetStrategy[];
}

export interface AiTargeting {
  locations?: Array<{ name?: string; city?: string }>;
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
  targeting?: AiTargeting;
  budget?: AiBudget;
  timing?: Record<string, unknown>;
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
