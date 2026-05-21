export interface StoreLocation {
  city: string;
  country: string;
  percentage: number;
}

export interface StoreProduct {
  id: string;
  name: string;
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
  order_velocity?: number;
  repeat_purchase_rate?: number;
  gateway_classification?: "Gateway" | "Consideration" | "Hybrid";
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
    peak_days: string[];
    peak_hours: number[];
    repeat_customer_rate: number;
    revenue_last_30_days: number;
    orders_last_30_days: number;
  };
  products: StoreProduct[];
  customers: {
    total_count: number;
    new_count: number;
    returning_count: number;
  };
  generated_at: string;
}
