import { StoreAcquisitionChannel, StoreData, StoreLocation, StoreProduct } from "../store-data";
import { consolidateLocation, consolidateLocationsWithAI } from "../locations";
import { fetchWithRetry } from "../http";
import { getEffectiveStoreCountry } from "../market-geography";
import { shopifyAdminRestUrl } from "../shopify-config";
import { fetchShopifyPrespendIntelligence } from "./shopify-intelligence";
import { buildProductDecisions } from "../gateway-decision";
import { summarizeOrderCountries } from "../order-geography";

// Shopify API types (subset)
interface ShopifyShop {
  name: string;
  domain: string;
  myshopify_domain: string;
  currency: string;
  country_code: string;
  money_format?: string;
}

interface ShopifyOrder {
  id: number;
  total_price: string;
  subtotal_price?: string;
  current_subtotal_price?: string;
  created_at: string;
  customer?: { id: number };
  billing_address?: { city?: string; province?: string; province_code?: string; country_code?: string; country?: string };
  shipping_address?: { city?: string; province?: string; province_code?: string; country_code?: string; country?: string };
  financial_status: string;
  source_name: string;
  referring_site?: string | null;
  landing_site?: string | null;
  line_items?: { product_id: number; quantity: number; price: string }[];
}

import { parseTrafficSource } from "./traffic-source";
export { parseTrafficSource };

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string;
  tags: string;
  product_type: string;
  vendor: string;
  created_at: string;
  variants: {
    id: number;
    title: string;
    price: string;
    inventory_quantity: number;
  }[];
  images: { src: string }[];
}

// Thin wrapper kept for the existing call sites. Now also does bounded retries
// (transient 5xx/429/network) on top of the per-attempt timeout — Shopify reads
// are idempotent GETs, so retrying is safe and makes store sync more resilient.
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 8000
): Promise<Response> {
  return fetchWithRetry(url, options, { timeoutMs });
}

async function shopifyGet<T>(
  shopDomain: string,
  accessToken: string,
  endpoint: string
): Promise<T | null> {
  try {
    const url = shopifyAdminRestUrl(shopDomain, endpoint);
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

function parseNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const links = linkHeader.split(",");
  for (const link of links) {
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

async function shopifyGetPaginated<T>(
  shopDomain: string,
  accessToken: string,
  initialEndpoint: string,
  dataKey: string,
  maxPages = 200 // Increased to 200 pages (50,000 records) for full lifetime ingestion
): Promise<T[]> {
  let results: T[] = [];
  let url = shopifyAdminRestUrl(shopDomain, initialEndpoint);
  let pagesFetched = 0;

  while (url && pagesFetched < maxPages) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        console.error(`Shopify API error: ${res.status} ${res.statusText} for URL ${url}`);
        throw new Error(`Incomplete Shopify ${dataKey} import: HTTP ${res.status}`);
      }

      const body = await res.json() as Record<string, T[]>;
      const items = body[dataKey];
      if (!Array.isArray(items)) throw new Error(`Invalid Shopify ${dataKey} response`);
      results = results.concat(items);
      pagesFetched++;

      // Check for next page
      const linkHeader = res.headers.get("Link");
      url = parseNextPageUrl(linkHeader) || "";
    } catch (error) {
      console.error(`Shopify fetch error for URL ${url}:`, error);
      throw error;
    }
  }

  if (url) throw new Error(`Incomplete Shopify ${dataKey} import: pagination limit reached`);
  return results;
}

export async function fetchShopifyStoreData(
  shopDomain: string,
  accessToken: string,
  userId?: string | null
): Promise<StoreData> {
  // STEP 1 — Fetch shop details
  const shopData = await shopifyGet<{ shop: ShopifyShop }>(
    shopDomain,
    accessToken,
    "shop.json"
  );

  const shop = shopData?.shop;
  if (!shop) throw new Error("Shopify store details unavailable; previous snapshot retained");

  // Fetch optional pre-spend datasets independently. Individual GraphQL
  // capability failures are recorded in the snapshot and never erase the
  // reliable order/product data that powers the existing dashboard.
  const intelligencePromise = fetchShopifyPrespendIntelligence(
    shopDomain,
    accessToken
  );

  // STEP 2 — Fetch true lifetime orders (removed 365-day truncation and 2k pagination cap)
  let orders: ShopifyOrder[];
  let ingestionComplete = true;
  try {
    orders = await shopifyGetPaginated<ShopifyOrder>(
      shopDomain,
      accessToken,
      `orders.json?status=any&financial_status=paid&limit=250&fields=id,total_price,subtotal_price,current_subtotal_price,created_at,customer,billing_address,shipping_address,financial_status,source_name,referring_site,landing_site,line_items`,
      "orders"
    );
  } catch (err) {
    console.error("Order ingestion incomplete:", err);
    orders = [];
    ingestionComplete = false;
  }

  const intelligence = await intelligencePromise;

  // STEP 3 — Fetch all active products using pagination
  let rawProducts: ShopifyProduct[];
  try {
    rawProducts = await shopifyGetPaginated<ShopifyProduct>(
      shopDomain,
      accessToken,
      "products.json?limit=250&status=active&fields=id,title,handle,body_html,variants,images,product_type,vendor,tags,created_at",
      "products"
    );
  } catch (err) {
    console.error("Product ingestion incomplete:", err);
    rawProducts = [];
    ingestionComplete = false;
  }

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

  // Helper: In Shopify Analytics, Average Order Value (AOV) is defined as
  // Net Sales (Product Subtotal excluding shipping & taxes) / Orders.
  // E.g. Order #K1166KASA: subtotal = ₦230,000 (shown in Shopify Admin as "NGN 230K AOV"),
  // while total_price = ₦253,250 (shown in Shopify Admin as "NGN 253.2K Total sales").
  const getOrderSubtotal = (o: ShopifyOrder) => {
    const val = parseFloat(o.current_subtotal_price || o.subtotal_price || o.total_price);
    return isNaN(val) ? 0 : val;
  };

  const subtotalLast30Days = ordersLast30Days.reduce(
    (sum, o) => sum + getOrderSubtotal(o),
    0
  );

  const aovSixtyDaysAgoMs = new Date().getTime() - (60 * 24 * 60 * 60 * 1000);
  const ordersLast60Days = orders.filter(
    (o) => new Date(o.created_at).getTime() >= aovSixtyDaysAgoMs
  );
  const subtotalLast60Days = ordersLast60Days.reduce(
    (sum, o) => sum + getOrderSubtotal(o),
    0
  );
  const totalSubtotal = orders.reduce(
    (sum, o) => sum + getOrderSubtotal(o),
    0
  );
  const rolling60dAov = ordersLast60Days.length > 0
    ? subtotalLast60Days / ordersLast60Days.length
    : (orders.length > 0 ? totalSubtotal / orders.length : 0);
  const thirtyDayAov = ordersLast30Days.length > 0
    ? subtotalLast30Days / ordersLast30Days.length
    : rolling60dAov;

  // Determine oldest order date
  const oldestOrderDate = orders.reduce(
    (oldest, o) => {
      const d = new Date(o.created_at);
      return d < oldest ? d : oldest;
    },
    new Date()
  );

  // Helper to validate locations and filter out junk or placeholders
  const isValidLocation = (loc: string | undefined | null) => {
    if (!loc) return false;
    const l = loc.trim().toLowerCase();
    return l !== "" && l !== "unknown" && l !== "null" && l !== "undefined" && l !== "none" && l !== "-" && l !== "false" && l !== "true";
  };

  // Dynamic AI Location consolidation
  const uniqueRawLocationsMap = new Map<string, string>();
  orders.forEach((order) => {
    const city =
      order.shipping_address?.city ||
      order.billing_address?.city ||
      order.shipping_address?.province ||
      order.billing_address?.province;
    const country = order.shipping_address?.country || order.shipping_address?.country_code || order.billing_address?.country_code || "Unknown";
    if (isValidLocation(city)) {
      uniqueRawLocationsMap.set(city!.trim(), country);
    }
  });

  const uniqueRawLocations = Array.from(uniqueRawLocationsMap.entries()).map(([city, country]) => ({ city, country }));

  // Pre-filter with local dictionary first so known cities (Lagos, Abuja, London, etc.) never burn AI tokens
  const unresolvedLocations = uniqueRawLocations.filter(({ city }) => {
    const staticResult = consolidateLocation(city);
    return !staticResult || staticResult === "Unknown";
  });

  let aiMapping: Record<string, string> = {};
  if (unresolvedLocations.length > 0) {
    try {
      aiMapping = await consolidateLocationsWithAI(unresolvedLocations, userId);
    } catch (e) {
      console.error("AI location consolidation failed, using static fallback:", e);
    }
  }

  // Location analysis
  const locationMap: Record<string, { count: number; country: string }> = {};
  orders.forEach((order) => {
    const city =
      order.shipping_address?.city ||
      order.billing_address?.city ||
      order.shipping_address?.province ||
      order.billing_address?.province;
    const country = order.shipping_address?.country || order.shipping_address?.country_code || order.billing_address?.country_code;

    const hasCity = isValidLocation(city);
    const hasCountry = isValidLocation(country);

    if (hasCity) {
      const cityTrimmed = city!.trim();
      const consolidatedCity = aiMapping[cityTrimmed] || consolidateLocation(cityTrimmed);
      if (consolidatedCity && consolidatedCity !== "Unknown") {
        const displayCountry = hasCountry ? country!.trim() : "Unknown";
        if (!locationMap[consolidatedCity]) {
          locationMap[consolidatedCity] = { count: 0, country: displayCountry };
        }
        locationMap[consolidatedCity].count += 1;
      }
    }
  });

  const topLocations: StoreLocation[] = Object.entries(locationMap)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 5)
    .map(([city, data]) => ({
      city,
      country: data.country,
      source: "from_data",
      percentage: orders.length > 0
        ? Math.round((data.count / orders.length) * 100)
        : 100,
    }));

  // Keep country-only evidence separate from city-level ad recommendations.
  const topOrderCountries = summarizeOrderCountries(orders);

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

  // Repeat customer detection and First Order tracking
  const customerOrderCount: Record<string, number> = {};
  const customerFirstOrder: Record<string, number> = {};
  
  const sortedOrders = [...orders].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  
  sortedOrders.forEach((order) => {
    const customerId = order.customer?.id?.toString();
    if (!customerId) return;
    customerOrderCount[customerId] = (customerOrderCount[customerId] || 0) + 1;
    if (!customerFirstOrder[customerId]) {
      customerFirstOrder[customerId] = order.id;
    }
  });

  const totalCustomers = Object.keys(customerOrderCount).length;
  const returningCustomers = Object.values(customerOrderCount).filter(
    (count) => count > 1
  ).length;
  const newCustomers = totalCustomers - returningCustomers;

  const repeatRate =
    totalCustomers > 0 ? returningCustomers / totalCustomers : 0;

  // STEP 5 — Process products
  // Build maps of product stats from order history
  const productSalesMap: Record<number, number> = {};
  const productSalesLast60DaysMap: Record<number, number> = {};
  const productOrdersMap: Record<number, Set<number>> = {};
  const productCustomersMap: Record<number, Set<string>> = {};
  const productCustomerOrderCountMap: Record<number, Record<string, number>> = {};
  const channelCount: Record<string, number> = {};
  const productChannelSalesMap: Record<number, Record<string, number>> = {};

  const sixtyDaysAgoMs = new Date().getTime() - (60 * 24 * 60 * 60 * 1000);

  orders.forEach((order) => {
    const customerId = order.customer?.id?.toString();
    const productsInOrder = new Set<number>();
    const isWithinLast60Days = new Date(order.created_at).getTime() >= sixtyDaysAgoMs;
    const channel = parseTrafficSource(
      order.referring_site,
      order.landing_site,
      order.source_name
    );
    channelCount[channel] = (channelCount[channel] || 0) + 1;

    order.line_items?.forEach((item) => {
      productSalesMap[item.product_id] =
        (productSalesMap[item.product_id] || 0) + item.quantity;
      
      if (isWithinLast60Days) {
        productSalesLast60DaysMap[item.product_id] =
          (productSalesLast60DaysMap[item.product_id] || 0) + item.quantity;
      }
      productsInOrder.add(item.product_id);

      if (!productChannelSalesMap[item.product_id]) {
        productChannelSalesMap[item.product_id] = {};
      }
      productChannelSalesMap[item.product_id][channel] =
        (productChannelSalesMap[item.product_id][channel] || 0) + item.quantity;
    });

    productsInOrder.forEach(pid => {
      if (!productOrdersMap[pid]) productOrdersMap[pid] = new Set();
      productOrdersMap[pid].add(order.id);

      if (!customerId) return;
      if (!productCustomersMap[pid]) productCustomersMap[pid] = new Set();
      productCustomersMap[pid].add(customerId);

      if (!productCustomerOrderCountMap[pid]) productCustomerOrderCountMap[pid] = {};
      productCustomerOrderCountMap[pid][customerId] = (productCustomerOrderCountMap[pid][customerId] || 0) + 1;
    });
  });

  const acquisition_channels: StoreAcquisitionChannel[] = Object.entries(channelCount)
    .sort(([, a], [, b]) => b - a)
    .map(([channel, count]) => ({
      channel,
      order_count: count,
      percentage: orders.length > 0 ? Math.round((count / orders.length) * 100) : 0,
    }));

  // Build actual revenue from order line items (not current price × units)
  const productRevenueMap: Record<number, number> = {};
  orders.forEach((order) => {
    order.line_items?.forEach((item) => {
      const itemRevenue = item.quantity * parseFloat(item.price || '0');
      productRevenueMap[item.product_id] = (productRevenueMap[item.product_id] || 0) + itemRevenue;
    });
  });

  const products: StoreProduct[] = rawProducts.map((product) => {
    const variants = product.variants || [];
    const images = product.images || [];
    const firstVariant = variants[0];
    const price = firstVariant ? parseFloat(firstVariant.price) : 0;
    const unitsSold = productSalesMap[product.id] || 0;
    const allOutOfStock = variants.length === 0 || variants.every(
      (v) => v.inventory_quantity <= 0
    );
    const anyInStock = variants.some(
      (v) => v.inventory_quantity > 0
    );
    const inStockVariants = variants.filter(
      (v) => v.inventory_quantity > 0
    );
    const totalVariants = variants.length;
    const hasPartialStock = 
      inStockVariants.length > 0 && 
      inStockVariants.length < totalVariants;

    const customersForProduct = productCustomersMap[product.id] || new Set();

    // Count unique customers whose very first store order contained this product
    let firstTimeBuyerCustomersCount = 0;
    customersForProduct.forEach((cid) => {
      const firstOrderId = customerFirstOrder[cid];
      if (firstOrderId && productOrdersMap[product.id]?.has(firstOrderId)) {
        firstTimeBuyerCustomersCount++;
      }
    });

    const first_time_buyer_ratio = customersForProduct.size > 0 
      ? firstTimeBuyerCustomersCount / customersForProduct.size 
      : 0;
    
    // Average units sold per month over the last 60 days
    const unitsSoldLast60 = productSalesLast60DaysMap[product.id] || 0;
    const order_velocity = unitsSoldLast60 / 2;

    // Count unique customers who placed more than one order containing this product
    let repeatCustomersForProduct = 0;
    const customerOrderCountsForProduct = productCustomerOrderCountMap[product.id] || {};
    Object.values(customerOrderCountsForProduct).forEach((count) => {
      if (count > 1) {
        repeatCustomersForProduct++;
      }
    });
    
    const repeat_purchase_rate = customersForProduct.size > 0 
      ? repeatCustomersForProduct / customersForProduct.size 
      : 0;

    // Top acquisition channel for this product
    const productChannels = productChannelSalesMap[product.id] || {};
    const topChannelEntry = Object.entries(productChannels).sort(([, a], [, b]) => b - a)[0];
    const top_acquisition_channel = topChannelEntry ? topChannelEntry[0] : undefined;
    const enrichment = intelligence.products[product.id.toString()];
    const unitCost = enrichment?.unitCost ?? null;

    return {
      id: product.id.toString(),
      name: product.title,
      handle: product.handle,
      revenue: productRevenueMap[product.id] || (unitsSold * price),
      units_sold: unitsSold,
      in_stock: anyInStock,
      price,
      collection: product.product_type || "",
      image_url: images[0]?.src || "",
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
      in_stock_variant_names: inStockVariants.map((v) => v.title),
      first_time_buyer_ratio,
      first_time_buyer_count: firstTimeBuyerCustomersCount,
      unique_customer_count: customersForProduct.size,
      order_velocity,
      repeat_purchase_rate,
      top_acquisition_channel,
      created_at: product.created_at || undefined,
      order_count: productOrdersMap[product.id]?.size || 0,
      unit_cost: unitCost,
      unit_cost_currency: enrichment?.currency,
      unit_cost_coverage: enrichment?.costCoverage || "missing",
      price_less_unit_cost: unitCost === null ? null : price - unitCost,
      catalog_claims: enrichment?.claims || [],
    };
  });

  const generatedAt = new Date().toISOString();
  const costCoverageByProduct = new Map(products.map((product) => [product.id, product.unit_cost_coverage]));
  const decisions = buildProductDecisions(
    orders,
    rawProducts.map((product) => ({
      id: product.id,
      variants: product.variants,
      unit_cost_coverage: costCoverageByProduct.get(String(product.id)),
    })),
    { asOf: generatedAt, ingestionComplete },
  );
  for (const product of products) {
    const decision = decisions.get(Number(product.id));
    if (!decision) continue;
    product.product_decision = decision;
    product.gateway_classification = decision.role;
  }

  // Sort products by revenue descending so the AI and dashboard prioritize top sellers
  products.sort((a, b) => b.revenue - a.revenue);

  // Extract currency symbol from money_format (e.g. "${{amount}}" -> "$", "€{{amount}}" -> "€")
  let symbol = "₦"; // Fallback
  if (shop?.money_format) {
    const match = shop.money_format.match(/^[^\d{]+/);
    if (match) symbol = match[0].trim();
    else if (shop.money_format.includes("€")) symbol = "€";
    else if (shop.money_format.includes("£")) symbol = "£";
  } else if (shop?.currency) {
    symbol = shop.currency; // Fallback to code if format missing
  }

  const anonymousOrders = orders.filter((o) => !o.customer?.id).length;
  const ordersWithoutCity = orders.filter(
    (o) =>
      !isValidLocation(
        o.shipping_address?.city ||
          o.billing_address?.city ||
          o.shipping_address?.province ||
          o.billing_address?.province
      )
  ).length;
  const qualityWarnings = [
    ...(!ingestionComplete ? ["Order or product data may be incomplete due to a sync error. Recommendations use the available data."] : []),
    ...(orders.length > 0 && anonymousOrders / orders.length > 0.4
      ? [`${anonymousOrders} guest checkout orders lacked customer IDs; repeat-buyer metrics reflect identified accounts.`]
      : []),
    ...(orders.length > 0 && ordersWithoutCity / orders.length > 0.4
      ? [`${ordersWithoutCity} orders lacked city/region details; geographic targeting is calibrated at the country level.`]
      : []),
    ...intelligence.warnings.filter((w) => !/GraphQL|syntax|unavailable:|argument\s+'sortKey'|shopifyqlQuery|access denied|field\s*\(|failed to fetch/i.test(w)),
  ];

  // STEP 6 — Return complete StoreData
  return {
    store: {
      name: shop?.name || shopDomain,
      domain: shop?.domain || shopDomain,
      currency: shop?.currency || "NGN",
      currency_symbol: symbol,
      country: getEffectiveStoreCountry(shop?.country_code, shop?.currency, topLocations),
      platform: "shopify",
    },
    orders: {
      total_revenue: totalRevenue,
      order_count: orders.length,
      average_order_value: Math.round(thirtyDayAov * 100) / 100,
      top_locations: topLocations,
      top_order_countries: topOrderCountries,
      peak_days: peakDays,
      peak_hours: peakHours,
      repeat_customer_rate: Math.round(repeatRate * 100) / 100,
      revenue_last_30_days: revenueLast30Days,
      orders_last_30_days: ordersLast30Days.length,
      revenue_last_60_days: ordersLast60Days.reduce(
        (sum, order) => sum + (Number(order.total_price) || 0),
        0
      ),
      oldest_order_date: oldestOrderDate.toISOString(),
      acquisition_channels,
    },
    products,
    customers: {
      total_count: totalCustomers,
      new_count: newCustomers,
      returning_count: returningCustomers,
    },
    prespend: intelligence.prespend,
    data_quality: {
      schema_version: 6,
      ingestion_complete: ingestionComplete,
      history_basis: "accessible_paid_orders",
      oldest_order_at: orders.length ? oldestOrderDate.toISOString() : undefined,
      anonymous_orders: anonymousOrders,
      orders_without_city: ordersWithoutCity,
      warnings: qualityWarnings,
    },
    generated_at: generatedAt,
  };
}
