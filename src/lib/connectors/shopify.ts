import { StoreData, StoreLocation, StoreProduct } from "../store-data";
import { consolidateLocation, consolidateLocationsWithAI } from "../locations";

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
  created_at: string;
  customer?: { id: number };
  billing_address?: { city?: string; country_code?: string };
  shipping_address?: { city?: string; country_code?: string; country?: string };
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
    title: string;
    price: string;
    inventory_quantity: number;
  }[];
  images: { src: string }[];
}

const API_VERSION = "2026-01";

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
  maxPages = 8
): Promise<T[]> {
  let results: T[] = [];
  let url = `https://${shopDomain}/admin/api/${API_VERSION}/${initialEndpoint}`;
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
        break;
      }

      const body = await res.json() as any;
      const items = body[dataKey] || [];
      results = results.concat(items);
      pagesFetched++;

      // Check for next page
      const linkHeader = res.headers.get("Link");
      url = parseNextPageUrl(linkHeader) || "";
    } catch (error) {
      console.error(`Shopify fetch error for URL ${url}:`, error);
      break;
    }
  }

  return results;
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

  // STEP 2 — Fetch last 365 days of orders with pagination support to fetch all history
  const oneYearAgo = new Date();
  oneYearAgo.setDate(oneYearAgo.getDate() - 365);
  const createdAtMin = oneYearAgo.toISOString();

  const orders = await shopifyGetPaginated<ShopifyOrder>(
    shopDomain,
    accessToken,
    `orders.json?status=any&created_at_min=${createdAtMin}&limit=250&fields=id,total_price,created_at,customer,billing_address,shipping_address,financial_status,source_name,line_items`,
    "orders"
  );

  // STEP 3 — Fetch all active products using pagination
  const rawProducts = await shopifyGetPaginated<ShopifyProduct>(
    shopDomain,
    accessToken,
    "products.json?limit=250&status=active&fields=id,title,body_html,variants,images,product_type,vendor,tags",
    "products"
  );

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

  // Compute AOV on a rolling 60-day window to avoid seasonal spikes distorting budget recommendations
  const aovSixtyDaysAgoMs = new Date().getTime() - (60 * 24 * 60 * 60 * 1000);
  const ordersLast60Days = orders.filter(
    (o) => new Date(o.created_at).getTime() >= aovSixtyDaysAgoMs
  );
  const revenueLast60Days = ordersLast60Days.reduce(
    (sum, o) => sum + parseFloat(o.total_price),
    0
  );
  const rolling60dAov = ordersLast60Days.length > 0 ? revenueLast60Days / ordersLast60Days.length : (orders.length > 0 ? totalRevenue / orders.length : 0);

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
    const city = order.shipping_address?.city || order.billing_address?.city;
    const country = order.shipping_address?.country || order.shipping_address?.country_code || order.billing_address?.country_code || "Unknown";
    if (isValidLocation(city)) {
      uniqueRawLocationsMap.set(city!.trim(), country);
    }
  });

  const uniqueRawLocations = Array.from(uniqueRawLocationsMap.entries()).map(([city, country]) => ({ city, country }));

  let aiMapping: Record<string, string> = {};
  if (uniqueRawLocations.length > 0) {
    try {
      aiMapping = await consolidateLocationsWithAI(uniqueRawLocations);
    } catch (e) {
      console.error("AI location consolidation failed, using static fallback:", e);
    }
  }

  // Location analysis
  const locationMap: Record<string, { count: number; country: string }> = {};
  orders.forEach((order) => {
    const city = order.shipping_address?.city || order.billing_address?.city;
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
    } else if (hasCountry) {
      const displayCountry = country!.trim();
      if (!locationMap[displayCountry]) {
        locationMap[displayCountry] = { count: 0, country: displayCountry };
      }
      locationMap[displayCountry].count += 1;
    }
  });

  // Fallback to store city/country if locationMap is completely empty
  if (Object.keys(locationMap).length === 0) {
    const shopCountry = shop?.country_code || "Nigeria";
    const shopCity = (shop as any)?.city || (shopCountry === "NG" || shopCountry === "Nigeria" ? "Lagos" : "New York");
    locationMap[shopCity] = { count: 1, country: shopCountry };
  }

  const topLocations: StoreLocation[] = Object.entries(locationMap)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 5)
    .map(([city, data]) => ({
      city,
      country: data.country,
      percentage: orders.length > 0
        ? Math.round((data.count / orders.length) * 100)
        : 100,
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

  // Repeat customer detection and First Order tracking
  const customerOrderCount: Record<string, number> = {};
  const customerFirstOrder: Record<string, number> = {};
  
  const sortedOrders = [...orders].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  
  sortedOrders.forEach((order) => {
    const customerId = order.customer?.id?.toString() || "guest_" + order.id;
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

  const sixtyDaysAgoMs = new Date().getTime() - (60 * 24 * 60 * 60 * 1000);

  orders.forEach((order) => {
    const customerId = order.customer?.id?.toString() || "guest_" + order.id;
    const productsInOrder = new Set<number>();
    const isWithinLast60Days = new Date(order.created_at).getTime() >= sixtyDaysAgoMs;

    order.line_items?.forEach((item) => {
      productSalesMap[item.product_id] =
        (productSalesMap[item.product_id] || 0) + item.quantity;
      
      if (isWithinLast60Days) {
        productSalesLast60DaysMap[item.product_id] =
          (productSalesLast60DaysMap[item.product_id] || 0) + item.quantity;
      }
      productsInOrder.add(item.product_id);
    });

    productsInOrder.forEach(pid => {
      if (!productOrdersMap[pid]) productOrdersMap[pid] = new Set();
      productOrdersMap[pid].add(order.id);

      if (!productCustomersMap[pid]) productCustomersMap[pid] = new Set();
      productCustomersMap[pid].add(customerId);

      if (!productCustomerOrderCountMap[pid]) productCustomerOrderCountMap[pid] = {};
      productCustomerOrderCountMap[pid][customerId] = (productCustomerOrderCountMap[pid][customerId] || 0) + 1;
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
      (v: any) => v.inventory_quantity > 0
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

    return {
      id: product.id.toString(),
      name: product.title,
      revenue: unitsSold * price,
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
      in_stock_variant_names: inStockVariants.map((v: any) => v.title),
      first_time_buyer_ratio,
      order_velocity,
      repeat_purchase_rate,
    };
  });

  // Dynamic Gateway Product Classification
  // Calculate store baseline FTB ratio (average across all products that have sales)
  const productsWithSales = products.filter(p => p.units_sold > 0);
  const baseline_ftb = productsWithSales.length > 0 
    ? productsWithSales.reduce((acc, p) => acc + (p.first_time_buyer_ratio || 0), 0) / productsWithSales.length 
    : 0;

  // Calculate store median velocity
  const velocities = productsWithSales.map(p => p.order_velocity || 0).sort((a,b) => a - b);
  const median_velocity = velocities.length > 0 ? velocities[Math.floor(velocities.length / 2)] : 0;
  const store_aov = rolling60dAov;

  products.forEach(p => {
    // Stock filter timing: No out-of-stock product should enter the scoring pipeline at all
    if (!p.in_stock) {
      p.gateway_classification = undefined;
      return;
    }

    if (p.units_sold < 3) {
      p.gateway_classification = "Insufficient Data";
      return;
    }

    const ftb = p.first_time_buyer_ratio || 0;
    const price = p.price || 0;
    const velocity = p.order_velocity || 0;
    const repeat = p.repeat_purchase_rate || 0;

    const isGateway = ftb > baseline_ftb && price < store_aov && velocity > median_velocity;
    const isConsideration = ftb <= baseline_ftb && price >= store_aov && repeat > 0.1; // "strong repeat purchase signals", >10% repeat is decent

    if (isGateway && !isConsideration) {
      p.gateway_classification = "Gateway";
    } else if (isConsideration && !isGateway) {
      p.gateway_classification = "Consideration";
    } else {
      p.gateway_classification = "Hybrid";
    }
  });

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

  // STEP 6 — Return complete StoreData
  return {
    store: {
      name: shop?.name || shopDomain,
      domain: shop?.domain || shopDomain,
      currency: shop?.currency || "NGN",
      currency_symbol: symbol,
      country: shop?.country_code || "",
      platform: "shopify",
    },
    orders: {
      total_revenue: totalRevenue,
      order_count: orders.length,
      average_order_value: Math.round(rolling60dAov * 100) / 100,
      top_locations: topLocations,
      peak_days: peakDays,
      peak_hours: peakHours,
      repeat_customer_rate: Math.round(repeatRate * 100) / 100,
      revenue_last_30_days: revenueLast30Days,
      orders_last_30_days: ordersLast30Days.length,
      oldest_order_date: oldestOrderDate.toISOString(),
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
