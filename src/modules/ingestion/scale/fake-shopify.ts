import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Gql } from "../bulk";

/**
 * A fake Shopify Admin API for the scale verification (Phase 2, task 12): bulk
 * operations whose results are generated deterministically from a profile, in
 * the exact JSONL the bulk queries produce (roots, then children with
 * __parentId). Nothing is held in memory or on disk: each result is generated
 * as it is streamed. It can refuse a domain (ACCESS_DENIED), expire a result
 * URL once, and report a file size that makes the importer stage in R2.
 * Used by the opt-in scale checks only.
 */
export interface ScaleProfile {
  products: number;
  variantsPerProduct: number;
  metafieldsPerProduct: number;
  locations: number;
  customers: number;
  windowOrders: number;
  historyOrders: number;
  /** Every nth order is refunded (one unit of its first line); every nth window order has a return. */
  refundEvery: number;
  returnEvery: number;
  windowStart: Date;
  now: Date;
}

export const PROFILES = {
  /** The incident shop of Phase 0: 70k products, 500k orders. */
  very_large: { products: 70_000, variantsPerProduct: 3, metafieldsPerProduct: 2, locations: 2, customers: 200_000, windowOrders: 500_000, historyOrders: 20_000, refundEvery: 20, returnEvery: 50 },
  small: { products: 300, variantsPerProduct: 2, metafieldsPerProduct: 1, locations: 2, customers: 400, windowOrders: 1_500, historyOrders: 200, refundEvery: 10, returnEvery: 25 },
} as const;

export type BulkKind = "catalog" | "inventory" | "customers" | "orders" | "history" | "returns";
type Node = Record<string, unknown>;
const gid = (type: string, id: number | string) => `gid://shopify/${type}/${id}`;
const money = (amount: number) => ({ shopMoney: { amount: amount.toFixed(2) } });
const MONTHS_OF_HISTORY = 24;

/** Which bulk query a text is, from what only that query selects. */
export function bulkKind(query: string): BulkKind {
  if (query.includes("inventoryItems")) return "inventory";
  if (query.includes("returnLineItems")) return "returns";
  if (query.includes("lineItems")) return query.includes("processed_at:<") ? "history" : "orders";
  if (query.includes("variants")) return "catalog";
  if (query.includes("customers")) return "customers";
  throw new Error(`unknown bulk query: ${query.slice(0, 80)}`);
}

function orderTime(profile: ScaleProfile, index: number, history: boolean): Date {
  const start = history ? profile.windowStart.getTime() - MONTHS_OF_HISTORY * 30 * 86_400_000 : profile.windowStart.getTime() + 60_000;
  const end = history ? profile.windowStart.getTime() - 60_000 : profile.now.getTime() - 60_000;
  const count = history ? profile.historyOrders : profile.windowOrders;
  return new Date(start + Math.floor(((end - start) * index) / Math.max(1, count)));
}

function* catalog(p: ScaleProfile): Generator<Node> {
  for (let product = 1; product <= p.products; product++) {
    const id = gid("Product", product);
    const at = new Date(p.windowStart.getTime() - (product % 365) * 86_400_000).toISOString();
    yield {
      id, title: `Product ${product}`, handle: `product-${product}`, status: "ACTIVE", productType: `Type ${product % 40}`, vendor: `Vendor ${product % 25}`,
      tags: [`tag-${product % 30}`, "scale"], isGiftCard: false, publishedAt: at, createdAt: at, updatedAt: at,
      category: { fullName: `Category ${product % 15}` }, description: `Generated product ${product} for the scale verification.`,
    };
    for (let v = 1; v <= p.variantsPerProduct; v++) {
      const variant = product * 10 + v;
      yield {
        id: gid("ProductVariant", variant), title: `Size ${v}`, sku: `SKU-${variant}`, position: v, price: (10 + (product % 90) + v).toFixed(2), compareAtPrice: null,
        taxable: true, inventoryPolicy: "DENY", inventoryQuantity: (product + v) % 17, createdAt: at, updatedAt: at, selectedOptions: [{ name: "Size", value: `${v}` }],
        inventoryItem: { id: gid("InventoryItem", variant), tracked: true, requiresShipping: true, countryCodeOfOrigin: null,
          unitCost: product % 7 === 0 ? null : { amount: (4 + (product % 30)).toFixed(2), currencyCode: "GBP" }, measurement: { weight: { value: 0.5, unit: "KILOGRAMS" } } },
        __parentId: id,
      };
    }
    for (let m = 1; m <= p.metafieldsPerProduct; m++) {
      yield { id: gid("Metafield", product * 10 + m), namespace: "specs", key: `field_${m}`, type: "single_line_text_field", value: `Value ${product}-${m}`, updatedAt: at, __parentId: id };
    }
  }
}

function* inventory(p: ScaleProfile): Generator<Node> {
  for (let product = 1; product <= p.products; product++) {
    for (let v = 1; v <= p.variantsPerProduct; v++) {
      const item = product * 10 + v;
      const id = gid("InventoryItem", item);
      yield { id };
      for (let l = 1; l <= p.locations; l++) {
        const quantity = (item + l) % 23;
        yield { id: `${gid("InventoryLevel", item * 10 + l)}?inventory_item_id=${item}`, updatedAt: p.windowStart.toISOString(), location: { id: gid("Location", l) },
          quantities: [{ name: "available", quantity }, { name: "on_hand", quantity: quantity + 1 }], __parentId: id };
      }
    }
  }
}

function* customers(p: ScaleProfile): Generator<Node> {
  for (let c = 1; c <= p.customers; c++) {
    const at = new Date(p.windowStart.getTime() - (c % 700) * 86_400_000).toISOString();
    yield { id: gid("Customer", c), createdAt: at, updatedAt: at, numberOfOrders: String(1 + (c % 5)), amountSpent: { amount: (20 + (c % 400)).toFixed(2), currencyCode: "GBP" } };
  }
}

interface OrderPlan { id: number; at: Date; lines: Array<{ id: number; product: number; variant: number; quantity: number; price: number; refunded: number }>; refunded: boolean; customer: number | null }
function plan(p: ScaleProfile, index: number, history: boolean): OrderPlan {
  const id = history ? p.windowOrders + index + 1 : index + 1;
  const lines = Array.from({ length: 1 + (id % 2) }, (_, k) => {
    const product = ((id * 7919 + k * 13) % p.products) + 1;
    const variant = product * 10 + ((id + k) % p.variantsPerProduct) + 1;
    const quantity = 1 + (id % 3);
    return { id: id * 10 + k + 1, product, variant, quantity, price: 10 + (product % 90) + ((variant % 10)), refunded: 0 };
  });
  const refunded = id % p.refundEvery === 0;
  if (refunded) lines[0].refunded = 1;
  return { id, at: orderTime(p, index, history), lines, refunded, customer: id % 5 === 0 ? null : ((id * 31) % p.customers) + 1 };
}

function* orders(p: ScaleProfile, history: boolean): Generator<Node> {
  const count = history ? p.historyOrders : p.windowOrders;
  for (let index = 0; index < count; index++) {
    const o = plan(p, index, history);
    const orderId = gid("Order", o.id);
    const subtotal = o.lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
    const refundAmount = o.refunded ? o.lines[0].price : 0;
    yield {
      id: orderId, name: `#${o.id}`, createdAt: o.at.toISOString(), processedAt: o.at.toISOString(), cancelledAt: null, updatedAt: o.at.toISOString(), test: false,
      sourceName: o.id % 4 === 0 ? "pos" : "web", displayFinancialStatus: o.refunded ? "PARTIALLY_REFUNDED" : "PAID", displayFulfillmentStatus: "FULFILLED",
      currencyCode: "GBP", presentmentCurrencyCode: "GBP", subtotalPriceSet: money(subtotal), totalDiscountsSet: money(0), totalTaxSet: money(subtotal * 0.2),
      totalShippingPriceSet: money(4.99), totalPriceSet: money(subtotal * 1.2 + 4.99), totalRefundedSet: money(refundAmount),
      customer: o.customer ? { id: gid("Customer", o.customer) } : null,
      shippingAddress: { city: ["Leeds", "London", "Lagos", "Manchester", "Abuja"][o.id % 5], provinceCode: null, countryCodeV2: o.id % 5 === 2 || o.id % 5 === 4 ? "NG" : "GB" },
      refunds: o.refunded ? [{ id: gid("Refund", o.id), createdAt: o.at.toISOString(), processedAt: o.at.toISOString(), totalRefundedSet: { shopMoney: { amount: refundAmount.toFixed(2), currencyCode: "GBP" } } }] : [],
    };
    for (const line of o.lines) {
      yield {
        id: gid("LineItem", line.id), title: `Product ${line.product}`, sku: `SKU-${line.variant}`, quantity: line.quantity, currentQuantity: line.quantity - line.refunded,
        product: { id: gid("Product", line.product) }, variant: { id: gid("ProductVariant", line.variant) },
        originalUnitPriceSet: money(line.price), totalDiscountSet: money(0), __parentId: orderId,
      };
    }
  }
}

function* returns(p: ScaleProfile): Generator<Node> {
  for (let index = 0; index < p.windowOrders; index++) {
    const o = plan(p, index, false);
    const orderId = gid("Order", o.id);
    yield { id: orderId };
    if (o.id % p.returnEvery !== 0) continue;
    const returnId = gid("Return", o.id);
    yield { id: returnId, name: `#${o.id}-R1`, status: "CLOSED", createdAt: o.at.toISOString(), closedAt: o.at.toISOString(), totalQuantity: 1, __parentId: orderId };
    yield { id: gid("ReturnLineItem", o.id), quantity: 1, returnReasonDefinition: { handle: "defective" }, fulfillmentLineItem: { lineItem: { id: gid("LineItem", o.lines[0].id) } }, __parentId: returnId };
  }
}

export function generate(kind: BulkKind, profile: ScaleProfile): Generator<Node> {
  switch (kind) {
    case "catalog": return catalog(profile);
    case "inventory": return inventory(profile);
    case "customers": return customers(profile);
    case "orders": return orders(profile, false);
    case "history": return orders(profile, true);
    case "returns": return returns(profile);
  }
}

/** Shopify's counts for the profile, as the import's counts query reads them. */
function counts(p: ScaleProfile) {
  return {
    productsCount: { count: p.products }, productVariantsCount: { count: p.products * p.variantsPerProduct }, customersCount: { count: p.customers },
    window: { count: p.windowOrders }, history: { count: p.historyOrders }, oldest: { nodes: [{ processedAt: orderTime(p, 0, p.historyOrders > 0).toISOString() }] },
    sampleProducts: { nodes: Array.from({ length: 25 }, () => ({ metafields: { nodes: Array.from({ length: p.metafieldsPerProduct }, (_, i) => ({ id: i })) } })) },
    sampleVariants: { nodes: Array.from({ length: 25 }, () => ({ inventoryItem: { inventoryLevels: { nodes: Array.from({ length: p.locations }, (_, i) => ({ id: i })) } } })) },
  };
}

export interface FakeShopifyOptions {
  profile: ScaleProfile;
  /** Bulk queries of these kinds fail with ACCESS_DENIED, as for an unapproved field. */
  deny?: ReadonlySet<BulkKind>;
  /** The first result URL of these kinds answers 403, as an expired signed URL does. */
  expireOnce?: ReadonlySet<BulkKind>;
  /** The file size an operation reports (bytes); at the staging threshold the importer stages in R2. */
  fileSize?: Partial<Record<BulkKind, number>>;
}

export interface FakeShopify {
  url: string;
  gql: Gql;
  operations: Array<{ id: number; kind: BulkKind; objectCount: number; resultRequests: number; expired: boolean }>;
  stop(): Promise<void>;
}

export async function startFakeShopify(options: FakeShopifyOptions): Promise<FakeShopify> {
  const operations: FakeShopify["operations"] = [];
  const objectCounts = new Map<BulkKind, number>();
  const expired = new Set<BulkKind>();
  const objectCount = (kind: BulkKind) => {
    if (!objectCounts.has(kind)) {
      let n = 0;
      for (const node of generate(kind, options.profile)) if (node) n++;
      objectCounts.set(kind, n);
    }
    return objectCounts.get(kind)!;
  };

  let base = "";
  const graphql = (query: string, variables: Record<string, unknown>): unknown => {
    if (query.includes("bulkOperationRunQuery")) {
      const kind = bulkKind(String(variables.query ?? ""));
      const id = operations.length + 1;
      operations.push({ id, kind, objectCount: options.deny?.has(kind) ? 0 : objectCount(kind), resultRequests: 0, expired: false });
      return { bulkOperationRunQuery: { bulkOperation: { id: gid("BulkOperation", id), status: "CREATED" }, userErrors: [] } };
    }
    if (query.includes("BulkOperation")) {
      const id = Number(String(variables.id).split("/").pop());
      const op = operations[id - 1];
      if (!op) return { node: null };
      const now = new Date().toISOString();
      if (options.deny?.has(op.kind)) {
        return { node: { id: gid("BulkOperation", id), status: "FAILED", errorCode: "ACCESS_DENIED", objectCount: "0", rootObjectCount: "0", fileSize: null, url: null, partialDataUrl: null, createdAt: now, completedAt: null } };
      }
      return { node: {
        id: gid("BulkOperation", id), status: "COMPLETED", errorCode: null, objectCount: String(op.objectCount), rootObjectCount: String(op.objectCount),
        fileSize: String(options.fileSize?.[op.kind] ?? 1_000), url: op.objectCount ? `${base}/results/${id}.jsonl` : null, partialDataUrl: null, createdAt: now, completedAt: now,
      } };
    }
    if (query.includes("productsCount")) return counts(options.profile);
    if (query.includes("locations(")) {
      return { locations: { nodes: Array.from({ length: options.profile.locations }, (_, i) => ({
        id: gid("Location", i + 1), name: `Location ${i + 1}`, isActive: true, fulfillsOnlineOrders: true, isFulfillmentService: false, address: { countryCode: "GB", provinceCode: "ENG" },
      })), pageInfo: { hasNextPage: false, endCursor: null } } };
    }
    throw new Error(`fake Shopify: unexpected query ${query.slice(0, 80)}`);
  };

  const server: Server = createServer(async (req, res) => {
    try {
      const result = /^\/results\/(\d+)\.jsonl$/.exec(req.url ?? "");
      if (req.method === "GET" && result) {
        const op = operations[Number(result[1]) - 1];
        if (!op) { res.writeHead(404).end(); return; }
        op.resultRequests += 1;
        if (options.expireOnce?.has(op.kind) && !expired.has(op.kind)) {
          expired.add(op.kind);
          op.expired = true;
          res.writeHead(403).end("expired");
          return;
        }
        res.writeHead(200, { "content-type": "application/jsonl" });
        for (const node of generate(op.kind, options.profile)) {
          if (!res.write(`${JSON.stringify(node)}\n`)) await new Promise((resolve) => res.once("drain", resolve));
          if (res.destroyed) return;
        }
        res.end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const { query, variables } = JSON.parse(body) as { query: string; variables?: Record<string, unknown> };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: graphql(query, variables ?? {}) }));
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: error instanceof Error ? error.message : "error" }] }));
    }
  });
  await new Promise<void>((resolve) => server.listen(Number(process.env.SCALE_FAKE_PORT ?? 0), "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: base, gql: fakeGql(base), operations, stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** A GraphQL client for a fake Shopify at `base` (also used by a separate runner process). */
export function fakeGql(base: string): Gql {
  return async <T,>(query: string, variables?: Record<string, unknown>) => {
    const res = await fetch(`${base}/admin/api/graphql.json`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
    return json.data as T;
  };
}
