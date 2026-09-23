export interface StoreLocation {
  city: string;
  country: string;
  percentage: number;
  source?: "from_data" | "recommended";
}

export interface StoreProduct {
  id: string;
  name: string;
  handle?: string;
  revenue: number;
  units_sold: number;
  in_stock: boolean;
  price: number;
  collection: string;
  image_url: string;
  should_advertise: boolean;
  reason?: string;
  description: string;
  tags: string[];
  product_type: string;
  has_partial_stock: boolean;
  in_stock_variant_count: number;
  total_variant_count: number;
  in_stock_variant_names?: string[];
  first_time_buyer_ratio?: number;
  first_time_buyer_count?: number;
  unique_customer_count?: number;
  order_velocity?: number;
  repeat_purchase_rate?: number;
  gateway_classification?: "Gateway" | "Consideration" | "Hybrid" | "Insufficient Data";
  gateway_evidence?: {
    ftb_vs_baseline: { product: number; baseline: number };
    price_vs_aov: { price: number; aov: number };
    velocity_vs_median: { velocity: number; median: number };
    repeat_rate: number;
  };
  product_decision?: ProductDecisionEvidence;
  top_acquisition_channel?: string;
  created_at?: string;
  order_count?: number;
  unit_cost?: number | null;
  unit_cost_currency?: string;
  unit_cost_coverage?: "complete" | "partial" | "missing";
  price_less_unit_cost?: number | null;
  catalog_claims?: StoreCatalogClaim[];
}

/** A reproducible product-role observation and a separate launch-readiness check. */
export interface ProductDecisionEvidence {
  logic_version: 1;
  source: "shopify_accessible_paid_orders_and_catalog";
  as_of: string;
  role: "Gateway" | "Consideration" | "Hybrid" | "Insufficient Data";
  role_confidence: "strong" | "directional" | "insufficient";
  first_order_count: number;
  identified_first_orders: number;
  first_order_reach: number | null;
  later_order_count: number;
  identified_later_orders: number;
  later_order_reach: number | null;
  role_reason: string;
  follow_up_60d: {
    eligible_first_order_buyers: number;
    buyers_with_another_order: number;
    repeat_rate: number | null;
  };
  test_readiness: "planning_candidate" | "review" | "hold";
  readiness_reasons: string[];
  limitations: string[];
}

export interface StoreCatalogClaim {
  key: string;
  value: string;
  source: "product_metafield" | "referenced_metaobject";
}

export interface StoreAnalytics {
  source: "shopifyql";
  window_days: number;
  recent_funnel?: StoreRecentFunnel | null;
  sessions: number | null;
  visitors: number | null;
  sessions_with_cart_additions: number | null;
  sessions_that_reached_checkout: number | null;
  sessions_that_completed_checkout: number | null;
  added_to_cart_rate: number | null;
  checkout_conversion_rate: number | null;
  conversion_rate: number | null;
  gross_sales: number | null;
  discounts: number | null;
  returns: number | null;
  net_sales: number | null;
  shipping_charges: number | null;
  taxes: number | null;
  total_sales: number | null;
  order_count: number | null;
  average_order_value: number | null;
  top_countries: Array<{
    country: string;
    sessions: number;
    completed_checkouts: number;
    conversion_rate: number | null;
  }>;
}

export interface StoreRecentFunnel {
  source: "shopifyql_sessions";
  window_days: 30;
  sessions: number | null;
  cart_sessions: number | null;
  checkout_sessions: number | null;
  completed_checkout_sessions: number | null;
  checkout_conversion_rate: number | null;
}

export interface StoreMarketReadiness {
  id: string;
  name: string;
  status: "ACTIVE" | "DRAFT" | string;
  countries: string[];
}

export interface StoreShippingZone {
  profile_id: string;
  profile_name: string;
  applies_to_all_products: boolean;
  zone_name: string;
  countries: string[];
  active_methods: number;
}

export interface StoreFulfillmentLocation {
  id: string;
  name: string;
  fulfills_online_orders: boolean;
  has_active_inventory: boolean;
}

export interface StorePolicyEvidence {
  type: string;
  title: string;
  body: string;
  url: string;
}

export interface StoreDiscountEvidence {
  id: string;
  title: string;
  summary: string;
  status: string;
}

export interface StoreMarketingEvidence {
  id: string;
  source: "marketing_event" | "integrated_campaign";
  title?: string;
  type?: string;
  status?: string;
  channel?: string;
  source_and_medium?: string;
  started_at?: string;
  ended_at?: string;
  updated_at?: string;
  spend?: number | null;
  currency?: string;
}

export interface StoreCapability {
  status: "available" | "missing_scope" | "unavailable" | "error";
  required_scopes: string[];
  detail?: string;
}

export interface StorePrespendIntelligence {
  granted_scopes: string[];
  missing_required_scopes: string[];
  capabilities: Record<string, StoreCapability>;
  analytics?: StoreAnalytics;
  markets: StoreMarketReadiness[];
  shipping_zones: StoreShippingZone[];
  fulfillment_locations: StoreFulfillmentLocation[];
  active_discounts: StoreDiscountEvidence[];
  marketing_history: StoreMarketingEvidence[];
  policies: StorePolicyEvidence[];
  locales: Array<{ locale: string; primary: boolean; published: boolean }>;
}

export interface StoreAcquisitionChannel {
  channel: string;
  order_count: number;
  percentage: number;
  source?: "from_data" | "recommended";
}

export interface StoreData {
  store: {
    name: string;
    domain: string;
    currency: string;
    currency_symbol?: string;
    country: string;
    platform: "shopify" | "woocommerce" | "bigcommerce" | "other";
  };
  orders: {
    total_revenue: number;
    order_count: number;
    average_order_value: number;
    top_locations: StoreLocation[];
    top_order_countries?: Array<{ country: string; order_count: number }>;
    peak_days: string[];
    peak_hours: number[];
    repeat_customer_rate: number;
    revenue_last_30_days: number;
    orders_last_30_days: number;
    revenue_last_60_days?: number;
    oldest_order_date?: string;
    acquisition_channels?: StoreAcquisitionChannel[];
  };
  products: StoreProduct[];
  customers: {
    total_count: number;
    new_count: number;
    returning_count: number;
  };
  prespend?: StorePrespendIntelligence;
  data_quality?: {
    schema_version: 2 | 3 | 4 | 5 | 6;
    ingestion_complete: boolean;
    history_basis: "accessible_paid_orders";
    oldest_order_at?: string;
    anonymous_orders: number;
    orders_without_city: number;
    warnings: string[];
  };
  generated_at: string;
}
