/**
 * Bulk JSONL units to commerce mirror rows (Phase 2, task 4). Pure.
 *
 * Rows match the tables of migrations 0024 and 0029 and their checks:
 * - Shopify enumerations lower-case;
 * - text and lists within their bounds;
 * - money as decimal strings, so Postgres numeric receives it exactly;
 * - presentment currency only when it differs;
 * - the raw city only when the country-aware normalised city differs;
 * - unit cost only with its currency.
 * Only Level 1 customer data is read.
 */
import { consolidateLocation } from "@/lib/location-rules";
import { gidType, parseGid } from "./gid";
import type { JsonlUnit } from "./jsonl";
import { DESCRIPTION_LIMIT } from "./queries";

type Json = Record<string, unknown>;

const str = (value: unknown, max?: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return max ? trimmed.slice(0, max) : trimmed;
};
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const int = (value: unknown): number | null => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? Math.max(-2147483648, Math.min(2147483647, Math.trunc(n))) : null;
};
const nonNegativeInt = (value: unknown): number | null => {
  const n = int(value);
  return n === null ? null : Math.max(0, n);
};
const at = (value: unknown): string | null => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null);
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);

/** A decimal amount as a string; never negative (the columns check >= 0). */
function amount(value: unknown): string | null {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : null;
  if (!raw || !/^-?\d+(\.\d+)?$/.test(raw)) return null;
  return raw.startsWith("-") ? "0" : raw;
}
const shopMoney = (set: unknown): string | null => amount(obj(obj(set)?.shopMoney)?.amount);

/** Shopify enumeration to the stored form: lower-case, letters and underscores, at most 40. */
export function enumValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalised = value.trim().toLowerCase().replace(/[^a-z_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return /^[a-z][a-z_]{0,39}$/.test(normalised) ? normalised : null;
}
const currency = (value: unknown): string | null => (typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null);
const country = (value: unknown): string | null => (typeof value === "string" && /^[A-Z]{2}$/.test(value) ? value : null);

/** The catalog field set rows are read with (products.fields_version, 0044): 2 is Phase 3's; null rows predate it. */
export const CATALOG_FIELDS_VERSION = 2;
/** The location field set (inventory_locations.fields_version, 0046): 2 adds fulfilment-service details. */
export const LOCATION_FIELDS_VERSION = 2;

export interface ProductRow {
  shopify_id: number; title: string; handle: string | null; status: string; product_type: string | null; vendor: string | null;
  category: string | null; tags: string[]; description_excerpt: string | null; is_gift_card: boolean; published_at: string | null;
  shopify_created_at: string | null; shopify_updated_at: string | null;
  fields_version: number; description_truncated: boolean | null; category_id: string | null; option_names: string[];
  has_only_default_variant: boolean | null; requires_selling_plan: boolean | null; is_bundle: boolean | null;
  combined_listing_role: "parent" | "child" | null; featured_image_url: string | null; featured_image_alt: string | null;
  featured_image_width: number | null; featured_image_height: number | null; media_count: number | null; online_store_url: string | null;
}
export interface UnitPriceMeasurement {
  measured_type: string; quantity_value: number | null; quantity_unit: string | null; reference_value: number | null; reference_unit: string | null;
}
export interface VariantRow {
  shopify_id: number; product_shopify_id: number; title: string | null; sku: string | null; position: number | null;
  selected_options: Array<{ name: string; value: string }>; price: string; compare_at_price: string | null; taxable: boolean | null;
  inventory_item_id: number | null; tracked: boolean | null; inventory_policy: string | null; inventory_quantity: number | null;
  requires_shipping: boolean | null; weight: string | null; weight_unit: string | null; unit_cost: string | null;
  unit_cost_currency: string | null; country_of_origin: string | null; shopify_created_at: string | null; shopify_updated_at: string | null;
  barcode: string | null; available_for_sale: boolean | null; requires_components: boolean | null;
  unit_price_measurement: UnitPriceMeasurement | null; harmonized_system_code: string | null; province_of_origin: string | null;
}
export interface MetafieldRow {
  owner_type: "product" | "variant"; owner_shopify_id: number;
  /** The product the owner belongs to: the batch applies a product's metafields only with the product. Not stored. */
  product_shopify_id: number;
  namespace: string; key: string; type: string; value_excerpt: string | null; value_truncated: boolean; shopify_updated_at: string | null;
}

const SELECTED_OPTIONS_BYTES = 1800;
const METAFIELD_VALUE_CHARS = 1000;
const positiveInt = (value: unknown): number | null => {
  const n = int(value);
  return n !== null && n > 0 ? n : null;
};
const collapse = (value: unknown, max: number): string | null => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : null);

/** Shopify's unit-price measurement, or null when the variant has none (Shopify then returns zeros and no type). */
function unitPriceMeasurement(value: unknown): UnitPriceMeasurement | null {
  const m = obj(value);
  const measuredType = enumValue(m?.measuredType);
  if (!m || !measuredType) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return {
    measured_type: measuredType, quantity_value: num(m.quantityValue), quantity_unit: enumValue(m.quantityUnit),
    reference_value: num(m.referenceValue), reference_unit: enumValue(m.referenceUnit),
  };
}

function mapMetafield(child: Json, owner: { type: "product" | "variant"; id: number }, productId: number): MetafieldRow | null {
  const namespace = str(child.namespace, 255);
  const key = str(child.key, 64);
  const kind = str(child.type, 64);
  if (!namespace || !key || !kind) return null;
  const value = typeof child.value === "string" ? child.value : null;
  return {
    owner_type: owner.type,
    owner_shopify_id: owner.id,
    product_shopify_id: productId,
    namespace,
    key,
    type: kind,
    value_excerpt: value === null ? null : value.slice(0, METAFIELD_VALUE_CHARS),
    value_truncated: value !== null && value.length > METAFIELD_VALUE_CHARS,
    shopify_updated_at: at(child.updatedAt),
  };
}

export function mapProductUnit(unit: JsonlUnit): { product: ProductRow | null; variants: VariantRow[]; metafields: MetafieldRow[] } {
  const root = unit.root;
  const productId = parseGid(root.id, "Product");
  if (productId === null) return { product: null, variants: [], metafields: [] };
  const tags = Array.isArray(root.tags) ? root.tags.map((tag) => str(tag, 255)).filter((tag): tag is string => Boolean(tag)).slice(0, 250) : [];
  const product: ProductRow = {
    shopify_id: productId,
    title: str(root.title, 255) ?? "(untitled)",
    handle: str(root.handle, 255),
    status: enumValue(root.status) ?? "unknown",
    product_type: str(root.productType, 255),
    vendor: str(root.vendor, 255),
    category: str(obj(root.category)?.fullName, 512),
    tags,
    description_excerpt: str(root.description, DESCRIPTION_LIMIT),
    is_gift_card: bool(root.isGiftCard) ?? false,
    published_at: at(root.publishedAt),
    shopify_created_at: at(root.createdAt),
    shopify_updated_at: at(root.updatedAt),
    fields_version: CATALOG_FIELDS_VERSION,
    // truncateAt returns at most DESCRIPTION_LIMIT characters, ending "..." when it cut the text.
    description_truncated: typeof root.description === "string"
      ? root.description.length >= DESCRIPTION_LIMIT && root.description.endsWith("...")
      : null,
    category_id: str(String(obj(root.category)?.id ?? "").replace(/^gid:\/\/shopify\/TaxonomyCategory\//, ""), 64),
    option_names: (Array.isArray(root.options) ? root.options : []).map((o) => str(obj(o)?.name, 255)).filter((n): n is string => Boolean(n)).slice(0, 10),
    has_only_default_variant: bool(root.hasOnlyDefaultVariant),
    requires_selling_plan: bool(root.requiresSellingPlan),
    is_bundle: bool(root.hasVariantsThatRequiresComponents),
    combined_listing_role: root.combinedListingRole === "PARENT" ? "parent" : root.combinedListingRole === "CHILD" ? "child" : null,
    ...featuredImage(root.featuredMedia),
    media_count: nonNegativeInt(obj(root.mediaCount)?.count),
    online_store_url: str(root.onlineStoreUrl, 1024),
  };

  const variants: VariantRow[] = [];
  const metafields: MetafieldRow[] = [];
  for (const child of unit.children) {
    const type = gidType(child.id);
    if (type === "ProductVariant") {
      const variantId = parseGid(child.id, "ProductVariant");
      const price = amount(child.price);
      if (variantId === null || price === null) continue;
      const item = obj(child.inventoryItem);
      const cost = obj(item?.unitCost);
      const costAmount = amount(cost?.amount);
      const costCurrency = currency(cost?.currencyCode);
      const weight = obj(obj(item?.measurement)?.weight);
      const options: Array<{ name: string; value: string }> = [];
      for (const option of Array.isArray(child.selectedOptions) ? child.selectedOptions : []) {
        const name = str(obj(option)?.name, 255);
        const value = str(obj(option)?.value, 255);
        if (!name || value === null) continue;
        if (JSON.stringify([...options, { name, value }]).length > SELECTED_OPTIONS_BYTES) break;
        options.push({ name, value });
      }
      variants.push({
        shopify_id: variantId,
        product_shopify_id: productId,
        title: str(child.title, 255),
        sku: str(child.sku, 255),
        position: nonNegativeInt(child.position),
        selected_options: options,
        price,
        compare_at_price: amount(child.compareAtPrice),
        taxable: bool(child.taxable),
        inventory_item_id: parseGid(item?.id, "InventoryItem"),
        tracked: bool(item?.tracked),
        inventory_policy: enumValue(child.inventoryPolicy),
        inventory_quantity: int(child.inventoryQuantity),
        requires_shipping: bool(item?.requiresShipping),
        weight: amount(weight?.value),
        weight_unit: enumValue(weight?.unit),
        unit_cost: costAmount !== null && costCurrency !== null ? costAmount : null,
        unit_cost_currency: costAmount !== null && costCurrency !== null ? costCurrency : null,
        country_of_origin: country(item?.countryCodeOfOrigin),
        shopify_created_at: at(child.createdAt),
        shopify_updated_at: at(child.updatedAt),
        barcode: str(child.barcode, 255),
        available_for_sale: bool(child.availableForSale),
        requires_components: bool(child.requiresComponents),
        unit_price_measurement: unitPriceMeasurement(child.unitPriceMeasurement),
        harmonized_system_code: str(item?.harmonizedSystemCode, 32),
        province_of_origin: str(item?.provinceCodeOfOrigin, 16),
      });
    } else if (type === "Metafield") {
      // A product's own metafield, or one of its variant's (bulk and by-ID units both name the parent).
      const parentVariant = gidType(child.__parentId) === "ProductVariant" ? parseGid(child.__parentId, "ProductVariant") : null;
      const row = mapMetafield(child, parentVariant === null ? { type: "product", id: productId } : { type: "variant", id: parentVariant }, productId);
      if (row) metafields.push(row);
    }
  }
  // A variant's metafields are kept only with the variant.
  const variantIds = new Set(variants.map((v) => v.shopify_id));
  return { product, variants, metafields: metafields.filter((m) => m.owner_type === "product" || variantIds.has(m.owner_shopify_id)) };
}

function featuredImage(media: unknown): Pick<ProductRow, "featured_image_url" | "featured_image_alt" | "featured_image_width" | "featured_image_height"> {
  const image = obj(obj(obj(media)?.preview)?.image);
  const url = str(image?.url, 1024);
  if (!url) return { featured_image_url: null, featured_image_alt: null, featured_image_width: null, featured_image_height: null };
  // Empty alt text is kept as empty: Shopify confirms there is none.
  return { featured_image_url: url, featured_image_alt: collapse(image?.altText, 512), featured_image_width: positiveInt(image?.width), featured_image_height: positiveInt(image?.height) };
}

/** Metaobject IDs a reference metafield's value names (a GID, or a JSON list of GIDs). */
export function metaobjectReferenceIds(type: string, value: string | null): number[] {
  if (!value || !/metaobject_reference|mixed_reference/.test(type)) return [];
  return [...value.matchAll(/gid:\/\/shopify\/Metaobject\/(\d{1,18})/g)].map((m) => Number(m[1]));
}

export interface MetafieldDefinitionRow {
  owner_type: "product" | "variant"; namespace: string; key: string; shopify_id: number; name: string; type: string; description: string | null;
}
export function mapMetafieldDefinition(node: unknown, ownerType: "product" | "variant"): MetafieldDefinitionRow | null {
  const d = obj(node);
  const id = parseGid(d?.id, "MetafieldDefinition");
  const namespace = str(d?.namespace, 255);
  const key = str(d?.key, 64);
  const name = str(d?.name, 255);
  const type = str(obj(d?.type)?.name, 64);
  if (id === null || !namespace || !key || !name || !type) return null;
  return { owner_type: ownerType, namespace, key, shopify_id: id, name, type, description: str(d?.description, 500) };
}

export interface MetaobjectDefinitionRow {
  shopify_id: number; type: string; name: string | null; display_name_key: string | null;
  field_definitions: Array<{ key: string; name: string | null; type: string | null }>;
}
const FIELD_DEFINITIONS_BYTES = 15_000;
export function mapMetaobjectDefinition(node: unknown): MetaobjectDefinitionRow | null {
  const d = obj(node);
  const id = parseGid(d?.id, "MetaobjectDefinition");
  const type = str(d?.type, 255);
  if (id === null || !type) return null;
  const fields: MetaobjectDefinitionRow["field_definitions"] = [];
  for (const f of Array.isArray(d?.fieldDefinitions) ? d.fieldDefinitions : []) {
    const key = str(obj(f)?.key, 64);
    if (!key) continue;
    const entry = { key, name: str(obj(f)?.name, 255), type: str(obj(obj(f)?.type)?.name, 64) };
    if (JSON.stringify([...fields, entry]).length > FIELD_DEFINITIONS_BYTES) break;
    fields.push(entry);
  }
  return { shopify_id: id, type, name: str(d?.name, 255), display_name_key: str(d?.displayNameKey, 64), field_definitions: fields };
}

export interface MetaobjectRow {
  shopify_id: number; type: string; handle: string | null; display_name: string | null; fields: Record<string, string>;
  fields_truncated: boolean; shopify_updated_at: string | null;
}
const METAOBJECT_FIELD_CHARS = 500;
const METAOBJECT_FIELDS_BYTES = 6_000;
/** A metaobject with its field values (each at most 500 characters, 6 KB in all); its display name is its definition's display field. */
export function mapMetaobject(node: unknown, displayNameKey: string | null): MetaobjectRow | null {
  const o = obj(node);
  const id = parseGid(o?.id, "Metaobject");
  const type = str(o?.type, 255);
  if (id === null || !type) return null;
  const fields: Record<string, string> = {};
  let truncated = false;
  for (const f of Array.isArray(o?.fields) ? o.fields : []) {
    const key = str(obj(f)?.key, 64);
    const value = obj(f)?.value;
    if (!key || typeof value !== "string") continue;
    if (value.length > METAOBJECT_FIELD_CHARS) truncated = true;
    const next = { ...fields, [key]: value.slice(0, METAOBJECT_FIELD_CHARS) };
    if (JSON.stringify(next).length > METAOBJECT_FIELDS_BYTES) { truncated = true; break; }
    Object.assign(fields, next);
  }
  return {
    shopify_id: id, type, handle: str(o?.handle, 255),
    display_name: (displayNameKey ? str(fields[displayNameKey], 255) : null) ?? str(o?.handle, 255),
    fields, fields_truncated: truncated, shopify_updated_at: at(o?.updatedAt),
  };
}

export interface OrderRow extends OrderAttribution {
  shopify_id: number; name: string | null; shopify_created_at: string; processed_at: string; cancelled_at: string | null;
  financial_status: string | null; fulfillment_status: string | null; currency: string; presentment_currency: string | null;
  subtotal: string; total_discounts: string; total_tax: string; total_shipping: string; total_price: string; total_refunded: string;
  customer_shopify_id: number | null; ship_country_code: string | null; ship_province_code: string | null;
  ship_city: string | null; ship_city_raw: string | null; source_name: string | null; is_test: boolean; shopify_updated_at: string | null;
  /** Shopify Collective: the order holds products a supplier fulfils (task 4). */
  product_network: boolean | null; return_status: string | null;
}

/**
 * An order's acquisition attribution (Phase 3, task 8), from Shopify's customer journey: signals that identify
 * no one. The referrer as a host only, the landing page as a path only (never a query string, which can carry
 * tokens or e-mail addresses), UTM parameters bounded; no referral code, IP or user agent.
 */
export interface OrderAttribution {
  visit_source: string | null; visit_source_type: string | null; referrer_host: string | null; landing_path: string | null;
  utm_source: string | null; utm_medium: string | null; utm_campaign: string | null;
  first_visit_source: string | null; first_visit_source_type: string | null;
  days_to_conversion: number | null; customer_order_index: number | null; journey_ready: boolean | null;
}
const urlOf = (value: unknown): URL | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value.trim(), "https://landing.invalid");
  } catch {
    return null;
  }
};
export function orderAttribution(journey: unknown): OrderAttribution {
  const j = obj(journey);
  const last = obj(j?.lastVisit);
  const first = obj(j?.firstVisit);
  const utm = obj(last?.utmParameters);
  const referrer = urlOf(last?.referrerUrl);
  const landing = urlOf(last?.landingPage);
  // UTM parameters as Shopify parsed them, else from the landing page's query (read here, never stored as a URL).
  const fromQuery = (name: string) => str(landing?.searchParams.get(`utm_${name}`), 100);
  const positive = (value: unknown) => {
    const n = nonNegativeInt(value);
    return n !== null && n >= 1 ? n : null;
  };
  return {
    visit_source: str(last?.source, 64),
    visit_source_type: enumValue(last?.sourceType),
    referrer_host: referrer && referrer.hostname !== "landing.invalid" ? str(referrer.hostname.toLowerCase(), 255) : null,
    landing_path: landing ? str(landing.pathname, 255) : null,
    utm_source: str(utm?.source, 100) ?? fromQuery("source"),
    utm_medium: str(utm?.medium, 100) ?? fromQuery("medium"),
    utm_campaign: str(utm?.campaign, 100) ?? fromQuery("campaign"),
    first_visit_source: str(first?.source, 64),
    first_visit_source_type: enumValue(first?.sourceType),
    days_to_conversion: nonNegativeInt(j?.daysToConversion),
    customer_order_index: positive(j?.customerOrderIndex),
    journey_ready: bool(j?.ready),
  };
}
export interface LineItemRow {
  shopify_id: number; order_shopify_id: number; product_shopify_id: number | null; variant_shopify_id: number | null;
  title: string | null; sku: string | null; quantity: number; current_quantity: number | null; refunded_quantity: number;
  unit_price: string; total_discount: string;
  restockable: boolean | null; non_fulfillable_quantity: number | null; requires_shipping: boolean | null; is_gift_card: boolean | null;
}
/** A refund's units for one product, from the refund's own line items (history arrivals, 0042). */
export interface RefundLineRow { refund_shopify_id: number; product_shopify_id: number | null; quantity: number }
export function mapRefundLines(refundId: number, lineNodes: unknown[]): RefundLineRow[] {
  return lineNodes.flatMap((node) => {
    const quantity = Number(obj(node)?.quantity);
    if (!Number.isInteger(quantity) || quantity === 0) return [];
    return [{ refund_shopify_id: refundId, product_shopify_id: parseGid(obj(obj(obj(node)?.lineItem)?.product)?.id, "Product"), quantity }];
  });
}
export interface RefundRow {
  /** processed_at: when the refund took effect (Shopify's processedAt, else createdAt); differs for refunds recorded after the fact. */
  shopify_id: number; order_shopify_id: number; shopify_created_at: string; processed_at: string; total_refunded: string; currency: string;
}

/** The destination as stored: the country-aware metro (GEO-01), with the raw city only when it differs. */
export function destination(address: unknown): Pick<OrderRow, "ship_country_code" | "ship_province_code" | "ship_city" | "ship_city_raw"> {
  const shipping = obj(address);
  const countryCode = country(shipping?.countryCodeV2);
  const raw = str(shipping?.city, 255);
  const city = raw ? (consolidateLocation(raw, countryCode) ?? raw) : null;
  return {
    ship_country_code: countryCode,
    ship_province_code: str(shipping?.provinceCode, 16),
    ship_city: city ? city.slice(0, 255) : null,
    ship_city_raw: raw && city !== raw ? raw : null,
  };
}

export function mapOrderUnit(unit: JsonlUnit): { order: OrderRow | null; lineItems: LineItemRow[]; refunds: RefundRow[] } {
  const root = unit.root;
  const orderId = parseGid(root.id, "Order");
  const shopCurrency = currency(root.currencyCode);
  const createdAt = at(root.createdAt);
  const processedAt = at(root.processedAt) ?? createdAt;
  const totalPrice = shopMoney(root.totalPriceSet);
  if (orderId === null || !shopCurrency || !createdAt || !processedAt || totalPrice === null) return { order: null, lineItems: [], refunds: [] };
  const presentment = currency(root.presentmentCurrencyCode);

  const order: OrderRow = {
    shopify_id: orderId,
    name: str(root.name, 64),
    shopify_created_at: createdAt,
    processed_at: processedAt,
    cancelled_at: at(root.cancelledAt),
    financial_status: enumValue(root.displayFinancialStatus),
    fulfillment_status: enumValue(root.displayFulfillmentStatus),
    currency: shopCurrency,
    presentment_currency: presentment && presentment !== shopCurrency ? presentment : null,
    subtotal: shopMoney(root.subtotalPriceSet) ?? "0",
    total_discounts: shopMoney(root.totalDiscountsSet) ?? "0",
    total_tax: shopMoney(root.totalTaxSet) ?? "0",
    total_shipping: shopMoney(root.totalShippingPriceSet) ?? "0",
    total_price: totalPrice,
    total_refunded: shopMoney(root.totalRefundedSet) ?? "0",
    customer_shopify_id: parseGid(obj(root.customer)?.id, "Customer"),
    ...destination(root.shippingAddress),
    source_name: str(root.sourceName, 64),
    is_test: bool(root.test) ?? false,
    shopify_updated_at: at(root.updatedAt),
    product_network: bool(root.productNetwork),
    return_status: enumValue(root.returnStatus),
    ...orderAttribution(root.customerJourneySummary),
  };

  const refunds: RefundRow[] = [];
  for (const refund of Array.isArray(root.refunds) ? root.refunds : []) {
    const refundId = parseGid(obj(refund)?.id, "Refund");
    const created = at(obj(refund)?.createdAt);
    const money = obj(obj(obj(refund)?.totalRefundedSet)?.shopMoney);
    const total = amount(money?.amount);
    if (refundId === null || !created || total === null) continue;
    refunds.push({
      shopify_id: refundId, order_shopify_id: orderId, shopify_created_at: created, processed_at: at(obj(refund)?.processedAt) ?? created,
      total_refunded: total, currency: currency(money?.currencyCode) ?? shopCurrency,
    });
  }

  // Bulk queries cannot nest a connection (refund line items) inside a list
  // (refunds), so a line's refunded units are what has left the order:
  // its original quantity less its current quantity (refunds and removals).
  const lineItems: LineItemRow[] = [];
  for (const child of unit.children) {
    if (gidType(child.id) !== "LineItem") continue;
    const lineId = parseGid(child.id, "LineItem");
    const quantity = nonNegativeInt(child.quantity);
    if (lineId === null || quantity === null) continue;
    const current = nonNegativeInt(child.currentQuantity);
    lineItems.push({
      shopify_id: lineId,
      order_shopify_id: orderId,
      product_shopify_id: parseGid(obj(child.product)?.id, "Product"),
      variant_shopify_id: parseGid(obj(child.variant)?.id, "ProductVariant"),
      title: str(child.title, 255),
      sku: str(child.sku, 255),
      quantity,
      current_quantity: current,
      refunded_quantity: current === null ? 0 : Math.max(0, quantity - Math.min(current, quantity)),
      unit_price: shopMoney(child.originalUnitPriceSet) ?? "0",
      total_discount: shopMoney(child.totalDiscountSet) ?? "0",
      restockable: bool(child.restockable),
      non_fulfillable_quantity: nonNegativeInt(child.nonFulfillableQuantity),
      requires_shipping: bool(child.requiresShipping),
      is_gift_card: bool(child.isGiftCard),
    });
  }
  return { order, lineItems, refunds };
}

export interface CustomerRow {
  shopify_id: number; orders_count: number | null; amount_spent: string | null; amount_spent_currency: string | null;
  shopify_created_at: string | null; shopify_updated_at: string | null;
}

export function mapCustomerUnit(unit: JsonlUnit): CustomerRow | null {
  const root = unit.root;
  const id = parseGid(root.id, "Customer");
  if (id === null) return null;
  const spent = obj(root.amountSpent);
  const spentAmount = amount(spent?.amount);
  const spentCurrency = currency(spent?.currencyCode);
  return {
    shopify_id: id,
    orders_count: nonNegativeInt(root.numberOfOrders),
    amount_spent: spentAmount !== null && spentCurrency ? spentAmount : null,
    amount_spent_currency: spentAmount !== null && spentCurrency ? spentCurrency : null,
    shopify_created_at: at(root.createdAt),
    shopify_updated_at: at(root.updatedAt),
  };
}

export interface InventoryLevelRow {
  inventory_item_id: number; location_shopify_id: number; available: number | null; on_hand: number | null; shopify_updated_at: string | null;
  committed: number | null; incoming: number | null; reserved: number | null; damaged: number | null; safety_stock: number | null;
  quality_control: number | null; is_active: boolean | null;
}

export function mapInventoryUnit(unit: JsonlUnit): InventoryLevelRow[] {
  const itemId = parseGid(unit.root.id, "InventoryItem");
  if (itemId === null) return [];
  const rows: InventoryLevelRow[] = [];
  for (const child of unit.children) {
    if (gidType(child.id) !== "InventoryLevel") continue;
    const locationId = parseGid(obj(child.location)?.id, "Location");
    if (locationId === null) continue;
    const quantities = new Map<string, number | null>();
    for (const q of Array.isArray(child.quantities) ? child.quantities : []) {
      const name = str(obj(q)?.name);
      if (name) quantities.set(name, int(obj(q)?.quantity));
    }
    const quantity = (name: string) => quantities.get(name) ?? null;
    rows.push({
      inventory_item_id: itemId,
      location_shopify_id: locationId,
      available: quantity("available"),
      on_hand: quantity("on_hand"),
      shopify_updated_at: at(child.updatedAt),
      committed: quantity("committed"),
      incoming: quantity("incoming"),
      reserved: quantity("reserved"),
      damaged: quantity("damaged"),
      safety_stock: quantity("safety_stock"),
      quality_control: quantity("quality_control"),
      is_active: bool(child.isActive),
    });
  }
  return rows;
}

/** Locations a by-ID inventory read names in full (Phase 3, task 3): stored with the levels, once each. */
export function mapInventoryLocations(unit: JsonlUnit): LocationRow[] {
  const seen = new Map<number, LocationRow>();
  for (const child of unit.children) {
    const location = obj(child.location);
    if (!location || typeof location.name !== "string") continue;
    const row = mapLocation(location);
    if (row) seen.set(row.shopify_id, row);
  }
  return [...seen.values()];
}

export interface LocationRow {
  shopify_id: number; name: string; country_code: string | null; province_code: string | null; is_active: boolean;
  fulfills_online_orders: boolean | null; is_fulfillment_service: boolean;
  fields_version: number; ships_inventory: boolean | null; has_active_inventory: boolean | null; deactivated_at: string | null;
  fulfillment_service_handle: string | null; fulfillment_service_name: string | null;
  fulfillment_service_type: "manual" | "third_party" | "gift_card" | null; fulfillment_service_inventory: boolean | null;
}
const FULFILLMENT_SERVICE_TYPES = new Set(["manual", "third_party", "gift_card"]);

export function mapLocation(node: unknown): LocationRow | null {
  const location = obj(node);
  const id = parseGid(location?.id, "Location");
  if (!location || id === null) return null;
  const address = obj(location.address);
  const service = obj(location.fulfillmentService);
  const serviceType = enumValue(service?.type);
  return {
    shopify_id: id,
    name: str(location.name, 255) ?? "(unnamed)",
    country_code: country(address?.countryCode),
    province_code: str(address?.provinceCode, 16),
    is_active: bool(location.isActive) ?? true,
    fulfills_online_orders: bool(location.fulfillsOnlineOrders),
    is_fulfillment_service: bool(location.isFulfillmentService) ?? false,
    fields_version: LOCATION_FIELDS_VERSION,
    ships_inventory: bool(location.shipsInventory),
    has_active_inventory: bool(location.hasActiveInventory),
    deactivated_at: at(location.deactivatedAt),
    fulfillment_service_handle: str(service?.handle, 255),
    fulfillment_service_name: str(service?.serviceName, 255),
    fulfillment_service_type: serviceType && FULFILLMENT_SERVICE_TYPES.has(serviceType) ? (serviceType as LocationRow["fulfillment_service_type"]) : null,
    fulfillment_service_inventory: bool(service?.inventoryManagement),
  };
}

/** The return field set (returns.fields_version, 0047): 2 adds the decline reason, approval time and processed quantities. */
export const RETURN_FIELDS_VERSION = 2;
const DECLINE_REASONS = new Set(["return_period_ended", "final_sale", "other"]);
export interface ReturnRow {
  shopify_id: number; order_shopify_id: number; name: string | null; status: string; total_quantity: number | null;
  shopify_created_at: string | null; closed_at: string | null;
  fields_version: number; decline_reason: "return_period_ended" | "final_sale" | "other" | null; request_approved_at: string | null;
}
export interface ReturnLineItemRow {
  shopify_id: number; return_shopify_id: number; line_item_shopify_id: number | null; quantity: number; return_reason: string | null;
  processed_quantity: number | null; refunded_quantity: number | null; unprocessed_quantity: number | null; return_reason_name: string | null;
  restocking_fee_amount: string | null; restocking_fee_percentage: number | null;
}
/** A refund that settles a return, from the return's side. */
export interface ReturnRefundRow { return_shopify_id: number; refund_shopify_id: number }

/** A returns unit is an order (id only) with its returns, their line items and their refunds as descendants. */
export function mapReturnsUnit(unit: JsonlUnit): { returns: ReturnRow[]; lineItems: ReturnLineItemRow[]; returnRefunds: ReturnRefundRow[] } {
  const orderId = parseGid(unit.root.id, "Order");
  if (orderId === null) return { returns: [], lineItems: [], returnRefunds: [] };
  const returns: ReturnRow[] = [];
  const lineItems: ReturnLineItemRow[] = [];
  const returnRefunds: ReturnRefundRow[] = [];
  for (const child of unit.children) {
    const type = gidType(child.id);
    if (type === "Return") {
      const id = parseGid(child.id, "Return");
      if (id === null) continue;
      returns.push({
        shopify_id: id,
        order_shopify_id: orderId,
        name: str(child.name, 64),
        status: enumValue(child.status) ?? "unknown",
        total_quantity: nonNegativeInt(child.totalQuantity),
        shopify_created_at: at(child.createdAt),
        closed_at: at(child.closedAt),
        fields_version: RETURN_FIELDS_VERSION,
        decline_reason: (() => {
          const reason = enumValue(obj(child.decline)?.reason);
          return reason && DECLINE_REASONS.has(reason) ? (reason as ReturnRow["decline_reason"]) : null;
        })(),
        request_approved_at: at(child.requestApprovedAt),
      });
    } else if (type === "ReturnLineItem" || type === "UnverifiedReturnLineItem") {
      const id = parseGid(child.id);
      const returnId = parseGid(child.__parentId, "Return");
      const quantity = nonNegativeInt(child.quantity);
      if (id === null || returnId === null || quantity === null) continue;
      lineItems.push({
        shopify_id: id,
        return_shopify_id: returnId,
        line_item_shopify_id: parseGid(obj(obj(child.fulfillmentLineItem)?.lineItem)?.id, "LineItem"),
        quantity,
        return_reason: enumValue(obj(child.returnReasonDefinition)?.handle),
        processed_quantity: nonNegativeInt(child.processedQuantity),
        refunded_quantity: nonNegativeInt(child.refundedQuantity),
        unprocessed_quantity: nonNegativeInt(child.unprocessedQuantity),
        return_reason_name: str(obj(child.returnReasonDefinition)?.name, 255),
        restocking_fee_amount: amount(obj(obj(obj(child.restockingFee)?.amountSet)?.shopMoney)?.amount),
        restocking_fee_percentage: (() => {
          const pct = obj(child.restockingFee)?.percentage;
          return typeof pct === "number" && pct >= 0 && pct <= 100 ? pct : null;
        })(),
      });
    } else if (type === "Refund") {
      const refundId = parseGid(child.id, "Refund");
      const returnId = parseGid(child.__parentId, "Return");
      if (refundId !== null && returnId !== null) returnRefunds.push({ return_shopify_id: returnId, refund_shopify_id: refundId });
    }
  }
  return { returns, lineItems, returnRefunds };
}

export interface RefundLineItemRow {
  shopify_id: number; refund_shopify_id: number; line_item_shopify_id: number | null; quantity: number;
  restock_type: "return" | "cancel" | "legacy_restock" | "no_restock" | null; subtotal: string | null;
}
const RESTOCK_TYPES = new Set(["return", "cancel", "legacy_restock", "no_restock"]);
/** A refund read by ID (task 4): the return it settles, and its line items. */
export function mapRefundNode(node: unknown, lineNodes: unknown[]): { refund: { shopify_id: number; return_shopify_id: number | null }; lines: RefundLineItemRow[] } | null {
  const refundId = parseGid(obj(node)?.id, "Refund");
  if (refundId === null) return null;
  const lines: RefundLineItemRow[] = [];
  for (const raw of lineNodes) {
    const line = obj(raw);
    const id = parseGid(line?.id, "RefundLineItem");
    const quantity = nonNegativeInt(line?.quantity);
    if (id === null || quantity === null) continue;
    const restock = enumValue(line?.restockType);
    lines.push({
      shopify_id: id, refund_shopify_id: refundId, line_item_shopify_id: parseGid(obj(line?.lineItem)?.id, "LineItem"), quantity,
      restock_type: restock && RESTOCK_TYPES.has(restock) ? (restock as RefundLineItemRow["restock_type"]) : null,
      subtotal: shopMoney(line?.subtotalSet),
    });
  }
  return { refund: { shopify_id: refundId, return_shopify_id: parseGid(obj(obj(node)?.return)?.id, "Return") }, lines };
}
