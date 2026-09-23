import { fetchWithRetry } from "../http";
import {
  getMissingShopifyScopes,
  shopifyAdminGraphqlUrl,
} from "../shopify-config";
import type {
  StoreAnalytics,
  StoreCapability,
  StoreCatalogClaim,
  StoreDiscountEvidence,
  StoreFulfillmentLocation,
  StoreMarketReadiness,
  StoreMarketingEvidence,
  StorePolicyEvidence,
  StorePrespendIntelligence,
  StoreShippingZone,
} from "../store-data";

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface ProductEnrichment {
  unitCost: number | null;
  currency?: string;
  costCoverage: "complete" | "partial" | "missing";
  claims: StoreCatalogClaim[];
}

export interface ShopifyIntelligenceResult {
  prespend: StorePrespendIntelligence;
  products: Record<string, ProductEnrichment>;
  warnings: string[];
}

class ShopifyGraphqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyGraphqlError";
  }
}

async function graphql<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await fetchWithRetry(
    shopifyAdminGraphqlUrl(shopDomain),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
    { timeoutMs: 12_000, retries: 1 }
  );

  if (!response.ok) {
    throw new ShopifyGraphqlError(
      `Shopify GraphQL HTTP ${response.status} ${response.statusText}`
    );
  }

  const payload = (await response.json()) as GraphqlEnvelope<T>;
  if (payload.errors?.length) {
    throw new ShopifyGraphqlError(
      payload.errors.map((error) => error.message || "Unknown GraphQL error").join("; ")
    );
  }
  if (!payload.data) throw new ShopifyGraphqlError("Shopify GraphQL returned no data");
  return payload.data;
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown Shopify error";
  return message.replace(/\s+/g, " ").slice(0, 240);
}

async function withTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new ShopifyGraphqlError(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[,%]/g, "").trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return value.includes("%") ? parsed / 100 : parsed;
}

interface ShopifyQlTable {
  columns?: Array<{ name?: string }>;
  rows?: unknown[];
}

export function normalizeShopifyQlRows(table?: ShopifyQlTable | null): Record<string, unknown>[] {
  if (!table?.rows) return [];
  const columnNames = (table.columns || []).map((column) => column.name || "");
  return table.rows.flatMap((row) => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      return [row as Record<string, unknown>];
    }
    if (Array.isArray(row) && columnNames.length) {
      return [Object.fromEntries(columnNames.map((name, index) => [name, row[index]]))];
    }
    return [];
  });
}

async function shopifyQl(
  shopDomain: string,
  accessToken: string,
  statement: string
): Promise<Record<string, unknown>[]> {
  const data = await graphql<{
    shopifyqlQuery: { tableData?: ShopifyQlTable | null; parseErrors?: unknown[] };
  }>(
    shopDomain,
    accessToken,
    `query PrespendShopifyQL($query: String!) {
      shopifyqlQuery(query: $query) {
        tableData { columns { name } rows }
        parseErrors
      }
    }`,
    { query: statement }
  );
  if (data.shopifyqlQuery.parseErrors?.length) {
    throw new ShopifyGraphqlError("ShopifyQL rejected a pre-spend analytics query");
  }
  return normalizeShopifyQlRows(data.shopifyqlQuery.tableData);
}

function metric(row: Record<string, unknown> | undefined, name: string): number | null {
  return numberValue(row?.[name]);
}

async function fetchAnalytics(
  shopDomain: string,
  accessToken: string
): Promise<StoreAnalytics> {
  const [funnelRows, salesRows, countryRows, recentFunnelRows] = await Promise.all([
    shopifyQl(
      shopDomain,
      accessToken,
      "FROM sessions SHOW sessions, online_store_visitors, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout, added_to_cart_rate, checkout_conversion_rate, conversion_rate WHERE human_or_bot_session = 'human' SINCE -90d UNTIL today"
    ),
    shopifyQl(
      shopDomain,
      accessToken,
      "FROM sales SHOW gross_sales, discounts, returns, net_sales, shipping_charges, taxes, total_sales, orders, average_order_value SINCE -90d UNTIL today"
    ),
    shopifyQl(
      shopDomain,
      accessToken,
      "FROM sessions SHOW sessions, sessions_that_completed_checkout, conversion_rate GROUP BY session_country WHERE human_or_bot_session = 'human' SINCE -90d UNTIL today ORDER BY sessions DESC LIMIT 20"
    ),
    shopifyQl(
      shopDomain,
      accessToken,
      "FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout, checkout_conversion_rate WHERE human_or_bot_session = 'human' SINCE -30d UNTIL today"
    ).catch((error) => {
      console.warn("Recent Shopify funnel unavailable:", error);
      return [];
    }),
  ]);

  const funnel = funnelRows[0];
  const recentFunnel = recentFunnelRows[0];
  const sales = salesRows[0];
  const topCountries = countryRows
    .map((row) => ({
      country: String(row.session_country || "Unknown"),
      sessions: metric(row, "sessions") || 0,
      completed_checkouts: metric(row, "sessions_that_completed_checkout") || 0,
      conversion_rate: metric(row, "conversion_rate"),
    }))
    .filter((row) => row.country !== "Unknown" && row.sessions > 0);

  return {
    source: "shopifyql",
    window_days: 90,
    recent_funnel: recentFunnel
      ? {
          source: "shopifyql_sessions",
          window_days: 30,
          sessions: metric(recentFunnel, "sessions"),
          cart_sessions: metric(recentFunnel, "sessions_with_cart_additions"),
          checkout_sessions: metric(recentFunnel, "sessions_that_reached_checkout"),
          completed_checkout_sessions: metric(recentFunnel, "sessions_that_completed_checkout"),
          checkout_conversion_rate: metric(recentFunnel, "checkout_conversion_rate"),
        }
      : null,
    sessions: metric(funnel, "sessions"),
    visitors: metric(funnel, "online_store_visitors"),
    sessions_with_cart_additions: metric(funnel, "sessions_with_cart_additions"),
    sessions_that_reached_checkout: metric(funnel, "sessions_that_reached_checkout"),
    sessions_that_completed_checkout: metric(funnel, "sessions_that_completed_checkout"),
    added_to_cart_rate: metric(funnel, "added_to_cart_rate"),
    checkout_conversion_rate: metric(funnel, "checkout_conversion_rate"),
    conversion_rate: metric(funnel, "conversion_rate"),
    gross_sales: metric(sales, "gross_sales"),
    discounts: metric(sales, "discounts"),
    returns: metric(sales, "returns"),
    net_sales: metric(sales, "net_sales"),
    shipping_charges: metric(sales, "shipping_charges"),
    taxes: metric(sales, "taxes"),
    total_sales: metric(sales, "total_sales"),
    order_count: metric(sales, "orders"),
    average_order_value: metric(sales, "average_order_value"),
    top_countries: topCountries,
  };
}

async function fetchGrantedScopes(shopDomain: string, accessToken: string): Promise<string[]> {
  const data = await graphql<{
    currentAppInstallation: { accessScopes: Array<{ handle: string }> };
  }>(
    shopDomain,
    accessToken,
    `query GrantedScopes {
      currentAppInstallation { accessScopes { handle } }
    }`
  );
  return data.currentAppInstallation.accessScopes.map((scope) => scope.handle).sort();
}

async function fetchMarkets(
  shopDomain: string,
  accessToken: string
): Promise<StoreMarketReadiness[]> {
  const data = await graphql<{
    markets: {
      nodes: Array<{
        id: string;
        name: string;
        status: string;
        regions: { nodes: Array<{ name: string; code?: string }> };
      }>;
    };
  }>(
    shopDomain,
    accessToken,
    `query PrespendMarkets {
      markets(first: 50) {
        nodes {
          id name status
          regions(first: 100) {
            nodes { name ... on MarketRegionCountry { code } }
          }
        }
      }
    }`
  );
  return data.markets.nodes.map((market) => ({
    id: market.id,
    name: market.name,
    status: market.status,
    countries: market.regions.nodes.map((region) => region.code || region.name).filter(Boolean),
  }));
}

async function fetchShippingZones(
  shopDomain: string,
  accessToken: string
): Promise<StoreShippingZone[]> {
  const data = await graphql<{
    deliveryProfiles: {
      nodes: Array<{
        id: string;
        name: string;
        coversAllItems: boolean;
        profileLocationGroups: Array<{
          locationGroupZones: {
            nodes: Array<{
              zone: {
                name: string;
                countries: Array<{ code: { countryCode?: string; restOfWorld?: boolean } }>;
              };
              methodDefinitions: { nodes: Array<{ active: boolean }> };
            }>;
          };
        }>;
      }>;
    };
  }>(
    shopDomain,
    accessToken,
    `query PrespendDeliveryProfiles {
      deliveryProfiles(first: 50) {
        nodes {
          id name coversAllItems
          profileLocationGroups {
            locationGroupZones(first: 100) {
              nodes {
                zone { name countries { code { countryCode restOfWorld } } }
                methodDefinitions(first: 50) { nodes { active } }
              }
            }
          }
        }
      }
    }`
  );

  return data.deliveryProfiles.nodes.flatMap((profile) =>
    profile.profileLocationGroups.flatMap((group) =>
      group.locationGroupZones.nodes.map((entry) => ({
        profile_id: profile.id,
        profile_name: profile.name,
        applies_to_all_products: profile.coversAllItems,
        zone_name: entry.zone.name,
        countries: entry.zone.countries.map((country) =>
          country.code.restOfWorld ? "REST_OF_WORLD" : country.code.countryCode || ""
        ).filter(Boolean),
        active_methods: entry.methodDefinitions.nodes.filter((method) => method.active).length,
      }))
    )
  );
}

async function fetchLocations(
  shopDomain: string,
  accessToken: string
): Promise<StoreFulfillmentLocation[]> {
  const data = await graphql<{
    locations: {
      nodes: Array<{
        id: string;
        name: string;
        fulfillsOnlineOrders: boolean;
        hasActiveInventory: boolean;
      }>;
    };
  }>(
    shopDomain,
    accessToken,
    `query PrespendLocations {
      locations(first: 100) {
        nodes { id name fulfillsOnlineOrders hasActiveInventory }
      }
    }`
  );
  return data.locations.nodes.map((location) => ({
    id: location.id,
    name: location.name,
    fulfills_online_orders: location.fulfillsOnlineOrders,
    has_active_inventory: location.hasActiveInventory,
  }));
}

async function fetchDiscounts(
  shopDomain: string,
  accessToken: string
): Promise<StoreDiscountEvidence[]> {
  const data = await graphql<{
    discountNodes: {
      nodes: Array<{
        id: string;
        discount: { title?: string; summary?: string; status?: string };
      }>;
    };
  }>(
    shopDomain,
    accessToken,
    `query ActiveDiscounts {
      discountNodes(first: 100, query: "status:active") {
        nodes {
          id
          discount {
            ... on DiscountCodeBasic { title summary status }
            ... on DiscountAutomaticBasic { title summary status }
            ... on DiscountCodeBxgy { title summary status }
            ... on DiscountAutomaticBxgy { title summary status }
            ... on DiscountCodeFreeShipping { title summary status }
            ... on DiscountAutomaticApp { title status }
            ... on DiscountCodeApp { title status }
          }
        }
      }
    }`
  );
  return data.discountNodes.nodes.map((node) => ({
    id: node.id,
    title: node.discount.title || "Untitled discount",
    summary: node.discount.summary || "",
    status: node.discount.status || "UNKNOWN",
  }));
}

async function fetchMarketingHistory(
  shopDomain: string,
  accessToken: string
): Promise<StoreMarketingEvidence[]> {
  const data = await graphql<{
    marketingEvents: {
      nodes: Array<{
        id: string;
        type: string;
        startedAt?: string | null;
        endedAt?: string | null;
        marketingChannelType?: string | null;
        sourceAndMedium?: string | null;
        description?: string | null;
      }>;
    };
    marketingActivities: {
      nodes: Array<{
        id: string;
        title: string;
        status: string;
        tactic: string;
        marketingChannelType: string;
        sourceAndMedium: string;
        updatedAt: string;
        adSpend?: { amount: string; currencyCode: string } | null;
      }>;
    };
  }>(
    shopDomain,
    accessToken,
    `query PrespendMarketingHistory {
      marketingEvents(first: 50, reverse: true, sortKey: STARTED_AT) {
        nodes {
          id type startedAt endedAt marketingChannelType sourceAndMedium description
        }
      }
      marketingActivities(first: 50, reverse: true, sortKey: CREATED_AT) {
        nodes {
          id title status tactic marketingChannelType sourceAndMedium updatedAt
          adSpend { amount currencyCode }
        }
      }
    }`
  );

  return [
    ...data.marketingEvents.nodes.map((event) => ({
      id: event.id,
      source: "marketing_event" as const,
      title: event.description || undefined,
      type: event.type,
      channel: event.marketingChannelType || undefined,
      source_and_medium: event.sourceAndMedium || undefined,
      started_at: event.startedAt || undefined,
      ended_at: event.endedAt || undefined,
    })),
    ...data.marketingActivities.nodes.map((activity) => ({
      id: activity.id,
      source: "integrated_campaign" as const,
      title: activity.title,
      type: activity.tactic,
      status: activity.status,
      channel: activity.marketingChannelType,
      source_and_medium: activity.sourceAndMedium,
      updated_at: activity.updatedAt,
      spend: activity.adSpend ? numberValue(activity.adSpend.amount) : null,
      currency: activity.adSpend?.currencyCode,
    })),
  ];
}

async function fetchPoliciesAndLocales(
  shopDomain: string,
  accessToken: string
): Promise<{
  policies: StorePolicyEvidence[];
  locales: Array<{ locale: string; primary: boolean; published: boolean }>;
}> {
  const [policyData, localeData] = await Promise.all([
    graphql<{
      shop: {
        shopPolicies: Array<{ type: string; title: string; body: string; url: string }>;
      };
    }>(
      shopDomain,
      accessToken,
      `query PrespendPolicies {
        shop { shopPolicies { type title body url } }
      }`
    ),
    graphql<{
      shopLocales: Array<{ locale: string; primary: boolean; published: boolean }>;
    }>(
      shopDomain,
      accessToken,
      `query PrespendLocales {
        shopLocales { locale primary published }
      }`
    ),
  ]);
  return {
    policies: policyData.shop.shopPolicies.map((policy) => ({
      ...policy,
      body: policy.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
    })),
    locales: localeData.shopLocales,
  };
}

function normalizeMetafieldClaim(
  metafield: {
    namespace: string;
    key: string;
    type: string;
    value: string;
    reference?: { type?: string; fields?: Array<{ key: string; value: string }> } | null;
  }
): StoreCatalogClaim[] {
  if (metafield.reference?.fields?.length) {
    return metafield.reference.fields
      .filter((field) => field.value && field.value.length <= 1_000)
      .map((field) => ({
        key: `${metafield.reference?.type || metafield.key}.${field.key}`,
        value: field.value,
        source: "referenced_metaobject" as const,
      }));
  }
  if (!metafield.value || metafield.value.length > 1_000) return [];
  if (metafield.type.includes("reference")) return [];
  return [{
    key: `${metafield.namespace}.${metafield.key}`,
    value: metafield.value,
    source: "product_metafield",
  }];
}

async function fetchProductEnrichment(
  shopDomain: string,
  accessToken: string
): Promise<Record<string, ProductEnrichment>> {
  type ProductNode = {
    legacyResourceId: string;
    metafields: {
      nodes: Array<{
        namespace: string;
        key: string;
        type: string;
        value: string;
        reference?: { type?: string; fields?: Array<{ key: string; value: string }> } | null;
      }>;
    };
    variants: {
      nodes: Array<{
        inventoryItem: { unitCost?: { amount: string; currencyCode: string } | null };
      }>;
    };
  };
  const products: ProductNode[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const data: {
      products: {
        nodes: ProductNode[];
        pageInfo: { hasNextPage: boolean; endCursor?: string | null };
      };
    } = await graphql(
      shopDomain,
      accessToken,
      `query PrespendProductEvidence($after: String) {
        products(first: 50, after: $after, query: "status:active") {
          nodes {
            legacyResourceId
            metafields(first: 50) {
              nodes {
                namespace key type value
                reference {
                  ... on Metaobject { type fields { key value } }
                }
              }
            }
            variants(first: 100) {
              nodes { inventoryItem { unitCost { amount currencyCode } } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after: cursor }
    );
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor || null : null;
    page += 1;
  } while (cursor && page < 20);

  return Object.fromEntries(products.map((product) => {
    const costs = product.variants.nodes
      .map((variant) => variant.inventoryItem.unitCost)
      .filter((cost): cost is { amount: string; currencyCode: string } => Boolean(cost))
      .map((cost) => ({ amount: Number(cost.amount), currency: cost.currencyCode }))
      .filter((cost) => Number.isFinite(cost.amount));
    const variantCount = product.variants.nodes.length;
    const averageCost = costs.length
      ? costs.reduce((total, cost) => total + cost.amount, 0) / costs.length
      : null;
    const claims = product.metafields.nodes.flatMap(normalizeMetafieldClaim);
    return [String(product.legacyResourceId), {
      unitCost: averageCost,
      currency: costs[0]?.currency,
      costCoverage: costs.length === 0
        ? "missing"
        : costs.length === variantCount
          ? "complete"
          : "partial",
      claims,
    } satisfies ProductEnrichment];
  }));
}

function capability(
  status: StoreCapability["status"],
  requiredScopes: string[],
  detail?: string
): StoreCapability {
  return { status, required_scopes: requiredScopes, ...(detail ? { detail } : {}) };
}

export async function fetchShopifyPrespendIntelligence(
  shopDomain: string,
  accessToken: string
): Promise<ShopifyIntelligenceResult> {
  let grantedScopes: string[] = [];
  const warnings: string[] = [];
  try {
    grantedScopes = await fetchGrantedScopes(shopDomain, accessToken);
  } catch (error) {
    warnings.push(`Could not verify granted Shopify scopes: ${compactError(error)}`);
  }
  const granted = new Set(grantedScopes);

  const tasks = {
    analytics: { scopes: ["read_reports"], run: () => fetchAnalytics(shopDomain, accessToken) },
    markets: { scopes: ["read_markets"], run: () => fetchMarkets(shopDomain, accessToken) },
    shipping: { scopes: ["read_shipping"], run: () => fetchShippingZones(shopDomain, accessToken) },
    locations: { scopes: ["read_locations"], run: () => fetchLocations(shopDomain, accessToken) },
    discounts: { scopes: ["read_discounts"], run: () => fetchDiscounts(shopDomain, accessToken) },
    marketing_history: {
      scopes: ["read_marketing_events", "read_marketing_integrated_campaigns"],
      run: () => fetchMarketingHistory(shopDomain, accessToken),
    },
    policies: {
      scopes: ["read_legal_policies", "read_locales"],
      run: () => fetchPoliciesAndLocales(shopDomain, accessToken),
    },
    product_evidence: {
      scopes: ["read_products", "read_inventory", "read_metaobjects"],
      run: () => fetchProductEnrichment(shopDomain, accessToken),
    },
  } as const;

  const entries = Object.entries(tasks);
  const settled = await Promise.all(entries.map(async ([name, task]) => {
    const missing = task.scopes.filter((scope) => grantedScopes.length > 0 && !granted.has(scope));
    if (missing.length) return [name, { missing, value: undefined }] as const;
    try {
      return [
        name,
        { missing: [], value: await withTimeout(task.run(), 25_000, name) },
      ] as const;
    } catch (error) {
      return [name, { missing: [], error: compactError(error), value: undefined }] as const;
    }
  }));

  const result = Object.fromEntries(settled) as Record<string, {
    missing: string[];
    error?: string;
    value?: unknown;
  }>;
  const capabilities: Record<string, StoreCapability> = {};
  for (const [name, task] of entries) {
    const item = result[name];
    capabilities[name] = item.missing.length
      ? capability("missing_scope", [...task.scopes], `Missing ${item.missing.join(", ")}`)
      : item.error
        ? capability("error", [...task.scopes], item.error)
        : capability("available", [...task.scopes]);
  }

  const policyValue = result.policies.value as Awaited<ReturnType<typeof fetchPoliciesAndLocales>> | undefined;
  return {
    prespend: {
      granted_scopes: grantedScopes,
      missing_required_scopes: grantedScopes.length ? getMissingShopifyScopes(grantedScopes) : [],
      capabilities,
      analytics: result.analytics.value as StoreAnalytics | undefined,
      markets: (result.markets.value as StoreMarketReadiness[] | undefined) || [],
      shipping_zones: (result.shipping.value as StoreShippingZone[] | undefined) || [],
      fulfillment_locations:
        (result.locations.value as StoreFulfillmentLocation[] | undefined) || [],
      active_discounts:
        (result.discounts.value as StoreDiscountEvidence[] | undefined) || [],
      marketing_history:
        (result.marketing_history.value as StoreMarketingEvidence[] | undefined) || [],
      policies: policyValue?.policies || [],
      locales: policyValue?.locales || [],
    },
    products:
      (result.product_evidence.value as Record<string, ProductEnrichment> | undefined) || {},
    warnings,
  };
}
