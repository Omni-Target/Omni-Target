/**
 * Shopify access verification (Phase 2, task 1). Pure: the probe query, the
 * Level 2 guard every ingestion query must pass, and the per-shop capability
 * matrix stored in shop_access.
 *
 * Decision 2026-11-18: Level 1 protected customer data only. Omnitarget never
 * requests a customer's name, email, phone, address lines, geolocation or zip
 * code. Destination city, province and country are requested; Shopify's
 * documentation does not classify them, so a shop that withholds them is
 * recorded and the fields stay null.
 */
import { orderHistoryWindow, type OrderHistoryBasis } from "@/modules/retention/policy";

export const DATA_DOMAINS = ["catalog", "orders", "customers", "inventory", "returns", "custom_data", "settings"] as const;
export type DataDomain = (typeof DATA_DOMAINS)[number];

/** Scopes each domain needs, and those whose absence makes it partial. */
export const DOMAIN_SCOPES: Record<DataDomain, { required: string[]; optional: string[] }> = {
  catalog: { required: ["read_products"], optional: [] },
  orders: { required: ["read_orders"], optional: ["read_all_orders"] },
  customers: { required: ["read_customers"], optional: [] },
  inventory: { required: ["read_inventory", "read_locations"], optional: [] },
  returns: { required: ["read_orders", "read_returns"], optional: [] },
  custom_data: { required: ["read_metaobjects", "read_metaobject_definitions"], optional: [] },
  settings: { required: [], optional: ["read_markets", "read_shipping", "read_locales", "read_legal_policies"] },
};

/** Level 2 protected customer data, never requested (names, contact details, address lines, geolocation, zip). */
const LEVEL_2_TOKENS = [
  "email", "phone", "firstName", "lastName", "displayName", "company", "address1", "address2", "zip",
  "latitude", "longitude", "defaultEmailAddress", "defaultPhoneNumber", "defaultAddress", "billingAddress",
  "addresses", "addressesV2", "emailMarketingConsent", "smsMarketingConsent", "contactEmail", "customerEmail",
];
/** The only destination fields requested from a shipping address. */
export const DESTINATION_FIELDS = ["city", "provinceCode", "countryCodeV2"] as const;

/** Throws if a query would request Level 2 data. Every ingestion query passes through this. */
export function assertLevel1Query(query: string): void {
  const found = LEVEL_2_TOKENS.filter((token) => new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`).test(query));
  if (found.length) throw new Error(`Query requests Level 2 customer data: ${found.join(", ")}`);
  for (const match of query.matchAll(/shippingAddress\s*\{([^}]*)\}/g)) {
    const fields = match[1].split(/[\s,]+/).filter(Boolean);
    const extra = fields.filter((field) => !(DESTINATION_FIELDS as readonly string[]).includes(field));
    if (extra.length) throw new Error(`Query requests address fields beyond the destination: ${extra.join(", ")}`);
  }
}

export const ACCESS_PROBE_QUERY = `query AccessProbe {
  currentAppInstallation { accessScopes { handle } }
  shop { id currencyCode ianaTimezone }
  oldestOrder: orders(first: 1, sortKey: PROCESSED_AT) { nodes { id processedAt } }
  recentOrder: orders(first: 1, sortKey: PROCESSED_AT, reverse: true) {
    nodes { id processedAt customer { id } shippingAddress { city provinceCode countryCodeV2 } }
  }
  customerProbe: customers(first: 1) { nodes { id numberOfOrders amountSpent { amount currencyCode } createdAt } }
}`;

export interface AccessProbeData {
  currentAppInstallation?: { accessScopes?: Array<{ handle: string }> } | null;
  shop?: { id: string; currencyCode?: string | null; ianaTimezone?: string | null } | null;
  oldestOrder?: { nodes?: Array<{ id: string; processedAt: string | null } | null> } | null;
  recentOrder?: { nodes?: Array<Record<string, unknown> | null> } | null;
  customerProbe?: { nodes?: Array<Record<string, unknown> | null> } | null;
}

/** Fields the probe checks, by the GraphQL path a denial reports (list indexes dropped). */
const PROBED: Record<string, { field: string; domain: DataDomain }> = {
  oldestOrder: { field: "Order", domain: "orders" },
  recentOrder: { field: "Order", domain: "orders" },
  "recentOrder.nodes.customer": { field: "Order.customer", domain: "orders" },
  "recentOrder.nodes.shippingAddress": { field: "Order.shippingAddress", domain: "orders" },
  "recentOrder.nodes.shippingAddress.city": { field: "Order.shippingAddress.city", domain: "orders" },
  "recentOrder.nodes.shippingAddress.provinceCode": { field: "Order.shippingAddress.provinceCode", domain: "orders" },
  "recentOrder.nodes.shippingAddress.countryCodeV2": { field: "Order.shippingAddress.countryCodeV2", domain: "orders" },
  customerProbe: { field: "Customer", domain: "customers" },
  "customerProbe.nodes.numberOfOrders": { field: "Customer.numberOfOrders", domain: "customers" },
  "customerProbe.nodes.amountSpent": { field: "Customer.amountSpent", domain: "customers" },
  "customerProbe.nodes.createdAt": { field: "Customer.createdAt", domain: "customers" },
};
const WHOLE_DOMAIN = new Set(["oldestOrder", "recentOrder", "customerProbe"]);

/** The probe entry a denied path belongs to: the longest probed path it starts with. */
function probedFor(path: string): { key: string; field: string; domain: DataDomain } | null {
  const key = Object.keys(PROBED)
    .filter((candidate) => path === candidate || path.startsWith(`${candidate}.`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? { key, ...PROBED[key] } : null;
}

export type DomainStatus = "available" | "partial" | "inaccessible";

export interface DomainAccess {
  status: DomainStatus;
  reasons: string[];
  /** Probed fields that could not be checked because the shop has no such record yet. */
  unverified_fields?: string[];
  history?: { from: string | null; basis: OrderHistoryBasis; missing_scope: string | null; oldest_reachable_order_at: string | null };
}

export interface ShopAccessReport {
  grantedScopes: string[];
  domains: Record<DataDomain, DomainAccess>;
  withheldFields: Record<string, { domain: DataDomain; reason: "ACCESS_DENIED" }>;
  shop: { currency: string | null; timezone: string | null };
}

/** write_x grants read_x. */
const hasScope = (granted: Set<string>, scope: string) => granted.has(scope) || granted.has(scope.replace(/^read_/, "write_"));


/** The capability matrix from what the probe returned and which fields Shopify withheld. */
export function buildAccessReport(data: AccessProbeData, deniedPaths: string[], now: Date = new Date()): ShopAccessReport {
  const grantedScopes = [...new Set((data.currentAppInstallation?.accessScopes ?? []).map((scope) => scope.handle))].sort();
  const granted = new Set(grantedScopes);

  const withheldFields: ShopAccessReport["withheldFields"] = {};
  const deniedDomains = new Set<DataDomain>();
  for (const path of deniedPaths) {
    const probed = probedFor(path);
    if (!probed) continue;
    if (WHOLE_DOMAIN.has(probed.key)) deniedDomains.add(probed.domain);
    else withheldFields[probed.field] = { domain: probed.domain, reason: "ACCESS_DENIED" };
  }

  const domains = {} as Record<DataDomain, DomainAccess>;
  for (const domain of DATA_DOMAINS) {
    const { required, optional } = DOMAIN_SCOPES[domain];
    const missing = required.filter((scope) => !hasScope(granted, scope));
    const reasons: string[] = [];
    let status: DomainStatus = "available";
    if (missing.length) {
      status = "inaccessible";
      reasons.push(...missing.map((scope) => `missing_scope:${scope}`));
    } else if (deniedDomains.has(domain)) {
      status = "inaccessible";
      reasons.push("access_denied");
    } else {
      const missingOptional = optional.filter((scope) => !hasScope(granted, scope));
      reasons.push(...missingOptional.map((scope) => `missing_scope:${scope}`));
      const withheld = Object.entries(withheldFields).filter(([, entry]) => entry.domain === domain).map(([field]) => `withheld:${field}`);
      reasons.push(...withheld);
      if (reasons.length) status = "partial";
    }
    domains[domain] = { status, reasons };
  }

  // A field is verified only by a sampled record that has a value for it: an
  // empty value with no denial (a guest order, no shipping address) proves nothing.
  const sampled = (connection: { nodes?: Array<Record<string, unknown> | null> } | null | undefined) =>
    (connection?.nodes ?? []).find((node): node is Record<string, unknown> => Boolean(node)) ?? null;
  const valueAt = (node: Record<string, unknown> | null, path: string[]) =>
    path.reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), node);
  const unverified = (domain: DataDomain, prefix: string, node: Record<string, unknown> | null) =>
    Object.entries(PROBED)
      .filter(([key, entry]) => entry.domain === domain && !WHOLE_DOMAIN.has(key) && !withheldFields[entry.field])
      .filter(([key]) => {
        const value = valueAt(node, key.slice(prefix.length).split("."));
        return value === null || value === undefined || value === "";
      })
      .map(([, entry]) => entry.field);
  if (domains.orders.status !== "inaccessible") {
    const fields = unverified("orders", "recentOrder.nodes.", sampled(data.recentOrder));
    if (fields.length) domains.orders.unverified_fields = fields;
  }
  if (domains.customers.status !== "inaccessible") {
    const fields = unverified("customers", "customerProbe.nodes.", sampled(data.customerProbe));
    if (fields.length) domains.customers.unverified_fields = fields;
  }

  const window = orderHistoryWindow(grantedScopes, now);
  const oldest = (data.oldestOrder?.nodes ?? []).find(Boolean)?.processedAt ?? null;
  domains.orders.history = {
    from: window.from ? window.from.toISOString() : null,
    basis: window.basis,
    missing_scope: window.missingScope,
    oldest_reachable_order_at: oldest,
  };

  return {
    grantedScopes,
    domains,
    withheldFields,
    shop: { currency: data.shop?.currencyCode ?? null, timezone: data.shop?.ianaTimezone ?? null },
  };
}
