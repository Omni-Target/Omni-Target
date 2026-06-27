export interface ProductRow {
  id?: string | number;
  name?: string;
  description?: string;
  image_url?: string;
  product_type?: string;
  price?: number;
  units_sold?: number;
  revenue?: number;
  in_stock?: boolean;
  has_partial_stock?: boolean;
  in_stock_variant_names?: string[];
  gateway_classification?: string;
}

export interface ProductLabel {
  text: string;
  tone: "success" | "brand" | "muted" | "faint";
  best?: boolean;
}
