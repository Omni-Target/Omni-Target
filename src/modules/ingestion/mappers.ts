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

export interface ProductRow {
  shopify_id: number; title: string; handle: string | null; status: string; product_type: string | null; vendor: string | null;
  category: string | null; tags: string[]; description_excerpt: string | null; is_gift_card: boolean; published_at: string | null;
  shopify_created_at: string | null; shopify_updated_at: string | null;
}
export interface VariantRow {
  shopify_id: number; product_shopify_id: number; title: string | null; sku: string | null; position: number | null;
  selected_options: Array<{ name: string; value: string }>; price: string; compare_at_price: string | null; taxable: boolean | null;
  inventory_item_id: number | null; tracked: boolean | null; inventory_policy: string | null; inventory_quantity: number | null;
  requires_shipping: boolean | null; weight: string | null; weight_unit: string | null; unit_cost: string | null;
  unit_cost_currency: string | null; country_of_origin: string | null; shopify_created_at: string | null; shopify_updated_at: string | null;
}
export interface MetafieldRow {
  owner_type: "product"; owner_shopify_id: number; namespace: string; key: string; type: string;
  value_excerpt: string | null; value_truncated: boolean; shopify_updated_at: string | null;
}

const SELECTED_OPTIONS_BYTES = 1800;

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
    description_excerpt: str(root.description, 1000),
    is_gift_card: bool(root.isGiftCard) ?? false,
    published_at: at(root.publishedAt),
    shopify_created_at: at(root.createdAt),
    shopify_updated_at: at(root.updatedAt),
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
      });
    } else if (type === "Metafield") {
      const namespace = str(child.namespace, 255);
      const key = str(child.key, 64);
      const kind = str(child.type, 64);
      if (!namespace || !key || !kind) continue;
      const value = typeof child.value === "string" ? child.value : null;
      metafields.push({
        owner_type: "product",
        owner_shopify_id: productId,
        namespace,
        key,
        type: kind,
        value_excerpt: value === null ? null : value.slice(0, 1000),
        value_truncated: value !== null && value.length > 1000,
        shopify_updated_at: at(child.updatedAt),
      });
    }
  }
  return { product, variants, metafields };
}

export interface OrderRow {
  shopify_id: number; name: string | null; shopify_created_at: string; processed_at: string; cancelled_at: string | null;
  financial_status: string | null; fulfillment_status: string | null; currency: string; presentment_currency: string | null;
  subtotal: string; total_discounts: string; total_tax: string; total_shipping: string; total_price: string; total_refunded: string;
  customer_shopify_id: number | null; ship_country_code: string | null; ship_province_code: string | null;
  ship_city: string | null; ship_city_raw: string | null; source_name: string | null; is_test: boolean; shopify_updated_at: string | null;
}
export interface LineItemRow {
  shopify_id: number; order_shopify_id: number; product_shopify_id: number | null; variant_shopify_id: number | null;
  title: string | null; sku: string | null; quantity: number; current_quantity: number | null; refunded_quantity: number;
  unit_price: string; total_discount: string;
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
    rows.push({
      inventory_item_id: itemId,
      location_shopify_id: locationId,
      available: quantities.get("available") ?? null,
      on_hand: quantities.get("on_hand") ?? null,
      shopify_updated_at: at(child.updatedAt),
    });
  }
  return rows;
}

export interface LocationRow {
  shopify_id: number; name: string; country_code: string | null; province_code: string | null; is_active: boolean;
  fulfills_online_orders: boolean | null; is_fulfillment_service: boolean;
}

export function mapLocation(node: unknown): LocationRow | null {
  const location = obj(node);
  const id = parseGid(location?.id, "Location");
  if (!location || id === null) return null;
  const address = obj(location.address);
  return {
    shopify_id: id,
    name: str(location.name, 255) ?? "(unnamed)",
    country_code: country(address?.countryCode),
    province_code: str(address?.provinceCode, 16),
    is_active: bool(location.isActive) ?? true,
    fulfills_online_orders: bool(location.fulfillsOnlineOrders),
    is_fulfillment_service: bool(location.isFulfillmentService) ?? false,
  };
}

export interface ReturnRow {
  shopify_id: number; order_shopify_id: number; name: string | null; status: string; total_quantity: number | null;
  shopify_created_at: string | null; closed_at: string | null;
}
export interface ReturnLineItemRow {
  shopify_id: number; return_shopify_id: number; line_item_shopify_id: number | null; quantity: number; return_reason: string | null;
}

/** A returns unit is an order (id only) with its returns and their line items as descendants. */
export function mapReturnsUnit(unit: JsonlUnit): { returns: ReturnRow[]; lineItems: ReturnLineItemRow[] } {
  const orderId = parseGid(unit.root.id, "Order");
  if (orderId === null) return { returns: [], lineItems: [] };
  const returns: ReturnRow[] = [];
  const lineItems: ReturnLineItemRow[] = [];
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
      });
    }
  }
  return { returns, lineItems };
}
