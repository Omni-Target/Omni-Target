import { StoreData, StoreLocation, StoreProduct } from "../store-data";
import { consolidateLocation } from "../locations";

// Shopify API types (subset)
interface ShopifyShop {
  name: string;
  domain: string;
  myshopify_domain: string;
  currency: string;
  country_code: string;
}

interface ShopifyOrder {
  id: number;
  total_price: string;
  created_at: string;
  customer?: { id: number };
  billing_address?: { city?: string; country_code?: string };
  financial_status: string;
  source_name: string;
  line_items?: { product_id: number; quantity: number }[];
}

interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string;
  tags: string;
  product_type: string;
  vendor: string;
  variants: {
    id: number;
    price: string;
    inventory_quantity: number;
  }[];
  images: { src: string }[];
}

const API_VERSION = "2024-01";

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 8000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(), 
    timeoutMs
  );
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function shopifyGet<T>(
  shopDomain: string,
  accessToken: string,
  endpoint: string
): Promise<T | null> {
  try {
    const url = `https://${shopDomain}/admin/api/${API_VERSION}/${endpoint}`;
    const res = await fetchWithTimeout(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      console.error(
        `Shopify API error: ${res.status} ${res.statusText} for ${endpoint}`
      );
      return null;
    }

    return (await res.json()) as T;
  } catch (error) {
    console.error(`Shopify fetch error (possibly timeout) for ${endpoint}:`, error);
    return null;
  }
}

export async function fetchShopifyStoreData(
  shopDomain: string,
  accessToken: string
): Promise<StoreData> {
  // STEP 1 — Fetch shop details
  const shopData = await shopifyGet<{ shop: ShopifyShop }>(
    shopDomain,
    accessToken,
    "shop.json"
  );

  const shop = shopData?.shop;

  // STEP 2 — Fetch last 90 days of orders
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const createdAtMin = ninetyDaysAgo.toISOString();

  const ordersData = await shopifyGet<{ orders: ShopifyOrder[] }>(
    shopDomain,
    accessToken,
    `orders.json?status=any&created_at_min=${createdAtMin}&limit=250&fields=id,total_price,created_at,customer,billing_address,financial_status,source_name,line_items`
  );

  const orders = ordersData?.orders || [];

  // STEP 3 — Fetch products
  const productsData = await shopifyGet<{ products: ShopifyProduct[] }>(
    shopDomain,
    accessToken,
    "products.json?limit=50&status=active&fields=id,title,body_html,variants,images,product_type,vendor,tags,collections"
  );

  const rawProducts = productsData?.products || [];

  // STEP 4 — Process orders into insights
  const thirtyDaysAgoForMetrics = new Date();
  thirtyDaysAgoForMetrics.setDate(thirtyDaysAgoForMetrics.getDate() - 30);
  const thirtyDaysAgoMs = thirtyDaysAgoForMetrics.getTime();

  const ordersLast30Days = orders.filter(
    (o) => new Date(o.created_at).getTime() >= thirtyDaysAgoMs
  );

  const revenueLast30Days = ordersLast30Days.reduce(
    (sum, o) => sum + parseFloat(o.total_price),
    0
  );

  const totalRevenue = orders.reduce(
    (sum, o) => sum + parseFloat(o.total_price),
    0
  );

  const aov = orders.length > 0 ? totalRevenue / orders.length : 0;

  // Location analysis
  const locationMap: Record<string, { count: number; country: string }> = {};
  orders.forEach((order) => {
    const rawCity = order.billing_address?.city || "Unknown";
    const city = consolidateLocation(rawCity);
    const country = order.billing_address?.country_code || "Unknown";
    if (!locationMap[city]) {
      locationMap[city] = { count: 0, country };
    }
    locationMap[city].count += 1;
  });

  const topLocations: StoreLocation[] = Object.entries(locationMap)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 5)
    .map(([city, data]) => ({
      city,
      country: data.country,
      percentage: orders.length > 0
        ? Math.round((data.count / orders.length) * 100)
        : 0,
    }));

  // Peak days analysis
  const dayCount: Record<string, number> = {};
  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  orders.forEach((order) => {
    const day = dayNames[new Date(order.created_at).getDay()];
    dayCount[day] = (dayCount[day] || 0) + 1;
  });

  const peakDays = Object.entries(dayCount)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([day]) => day);

  // Peak hours analysis
  const hourCount: Record<number, number> = {};
  orders.forEach((order) => {
    const hour = new Date(order.created_at).getHours();
    hourCount[hour] = (hourCount[hour] || 0) + 1;
  });

  const peakHours = Object.entries(hourCount)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([hour]) => parseInt(hour));

  // Repeat customer detection
  const customerOrderCount: Record<string, number> = {};
  orders.forEach((order) => {
    const customerId = order.customer?.id?.toString() || "guest";
    customerOrderCount[customerId] = (customerOrderCount[customerId] || 0) + 1;
  });

  const totalCustomers = Object.keys(customerOrderCount).length;
  const returningCustomers = Object.values(customerOrderCount).filter(
    (count) => count > 1
  ).length;
  const newCustomers = totalCustomers - returningCustomers;

  const repeatRate =
    totalCustomers > 0 ? returningCustomers / totalCustomers : 0;

  // STEP 5 — Process products
  // Build a map of product_id -> units sold from order line items
  const productSalesMap: Record<number, number> = {};
  orders.forEach((order) => {
    order.line_items?.forEach((item) => {
      productSalesMap[item.product_id] =
        (productSalesMap[item.product_id] || 0) + item.quantity;
    });
  });

  const products: StoreProduct[] = rawProducts.map((product) => {
    const firstVariant = product.variants[0];
    const price = firstVariant ? parseFloat(firstVariant.price) : 0;
    const unitsSold = productSalesMap[product.id] || 0;
    const allOutOfStock = product.variants.every(
      (v) => v.inventory_quantity <= 0
    );
    const anyInStock = product.variants.some(
      (v) => v.inventory_quantity > 0
    );
    const variants = product.variants || [];
    const inStockVariants = variants.filter(
      (v: any) => v.inventory_quantity > 0
    );
    const totalVariants = variants.length;
    const hasPartialStock = 
      inStockVariants.length > 0 && 
      inStockVariants.length < totalVariants;

    return {
      id: product.id.toString(),
      name: product.title,
      revenue: unitsSold * price,
      units_sold: unitsSold,
      in_stock: anyInStock,
      price,
      collection: product.product_type || "",
      image_url: product.images[0]?.src || "",
      should_advertise: !allOutOfStock,
      reason: allOutOfStock ? "Out of stock" : undefined,
      description: product.body_html
        ?.replace(/<[^>]*>/g, " ")
        ?.replace(/\s+/g, " ")
        ?.trim() || "",
      tags: product.tags 
        ? product.tags.split(",")
          .map((t: string) => t.trim())
        : [],
      product_type: product.product_type || "",
      has_partial_stock: hasPartialStock,
      in_stock_variant_count: inStockVariants.length,
      total_variant_count: totalVariants,
    };
  });

  // STEP 6 — Return complete StoreData
  return {
    store: {
      name: shop?.name || shopDomain,
      domain: shop?.domain || shopDomain,
      currency: shop?.currency || "NGN",
      country: shop?.country_code || "",
      platform: "shopify",
    },
    orders: {
      total_revenue: totalRevenue,
      order_count: orders.length,
      average_order_value: Math.round(aov * 100) / 100,
      top_locations: topLocations,
      peak_days: peakDays,
      peak_hours: peakHours,
      repeat_customer_rate: Math.round(repeatRate * 100) / 100,
      revenue_last_30_days: revenueLast30Days,
      orders_last_30_days: ordersLast30Days.length,
    },
    products,
    customers: {
      total_count: totalCustomers,
      new_count: newCustomers,
      returning_count: returningCustomers,
    },
    generated_at: new Date().toISOString(),
  };
}
