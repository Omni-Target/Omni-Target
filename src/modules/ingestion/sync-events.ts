import { parseGid } from "./gid";
import type { JsonlUnit } from "./jsonl";

/**
 * Incremental sync events (Phase 2, task 10). Pure.
 *
 * Webhooks arrive thin: the subscriptions ask Shopify for an identifier and a
 * change time only (includeFields), and the inbox keeps nothing else. Each
 * event names one resource; the worker fetches that resource's current state
 * from Shopify by ID, so the order and number of deliveries do not matter.
 */
export type SyncKind = "order" | "product" | "customer" | "inventory" | "return";

const KIND_BY_TOPIC: Record<string, SyncKind> = {
  "orders/create": "order", "orders/updated": "order", "orders/cancelled": "order", "orders/delete": "order", "refunds/create": "order",
  "products/create": "product", "products/update": "product", "products/delete": "product",
  "customers/create": "customer", "customers/update": "customer", "customers/delete": "customer",
  "inventory_levels/update": "inventory",
  "returns/request": "return", "returns/approve": "return", "returns/decline": "return", "returns/cancel": "return",
  "returns/close": "return", "returns/reopen": "return", "returns/process": "return", "returns/update": "return",
};
export const SYNC_TOPICS: ReadonlySet<string> = new Set(Object.keys(KIND_BY_TOPIC));

/** The only payload keys kept (0040's is_thin_event_payload enforces the same list). */
export const THIN_KEYS = ["id", "updated_at", "created_at", "order_id", "inventory_item_id", "location_id", "admin_graphql_api_id", "status"] as const;

export function thinPayload(payload: unknown): Record<string, string | number | null> {
  const thin: Record<string, string | number | null> = {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return thin;
  for (const key of THIN_KEYS) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number" || value === null) thin[key] = value;
  }
  return thin;
}

const positiveId = (value: unknown): number | null => {
  const id = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/** The resource an event names, or null when its payload names none. */
export function resourceOf(topic: string, payload: Record<string, unknown> | null): { kind: SyncKind; id: number } | null {
  const kind = KIND_BY_TOPIC[topic];
  if (!kind || !payload) return null;
  const id =
    topic === "refunds/create" ? positiveId(payload.order_id)
    : kind === "inventory" ? positiveId(payload.inventory_item_id)
    : kind === "return" ? parseGid(payload.admin_graphql_api_id, "Return") ?? positiveId(payload.id)
    : positiveId(payload.id);
  return id === null ? null : { kind, id };
}

export interface SyncEventRow {
  id: string;
  topic: string;
  payload: Record<string, unknown> | null;
}

export interface SyncResource {
  kind: SyncKind;
  id: number;
  eventIds: string[];
}

/** Events grouped by the resource they name: several deliveries about one order mean one fetch. */
export function groupResources(events: SyncEventRow[]): { resources: SyncResource[]; unusable: string[] } {
  const byKey = new Map<string, SyncResource>();
  const unusable: string[] = [];
  for (const event of events) {
    const resource = resourceOf(event.topic, event.payload);
    if (!resource) {
      unusable.push(event.id);
      continue;
    }
    const key = `${resource.kind}:${resource.id}`;
    const existing = byKey.get(key);
    if (existing) existing.eventIds.push(event.id);
    else byKey.set(key, { ...resource, eventIds: [event.id] });
  }
  return { resources: [...byKey.values()], unusable };
}

type Raw = Record<string, unknown>;
const connectionEdges = (value: unknown): unknown[] | null =>
  value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as Raw).edges) ? (value as Raw).edges as unknown[] : null;

/**
 * A by-ID GraphQL node as the unit a bulk export would give: its own fields as
 * the root, and every node of its connections (at any depth) as children
 * carrying __parentId, so the bulk mappers read both alike.
 */
export function unitFromNode(node: Raw): JsonlUnit {
  const children: Raw[] = [];
  const split = (value: Raw, parentId: string | null): Raw => {
    const own: Raw = {};
    const nested: Raw[] = [];
    for (const [key, field] of Object.entries(value)) {
      const edges = connectionEdges(field);
      if (edges) {
        for (const edge of edges) {
          const child = (edge as Raw | null)?.node;
          if (child && typeof child === "object") nested.push(child as Raw);
        }
        continue;
      }
      own[key] = field;
    }
    if (parentId) own.__parentId = parentId;
    for (const child of nested) {
      const index = children.length;
      children.push({});
      children[index] = split(child, String(value.id));
    }
    return own;
  };
  const root = split(node, null);
  return { root, children, firstLine: 0, lastLine: 0 };
}

/** Units in groups of at most maxRows rows (a unit is its root and children), each unit kept whole. */
export function chunkUnits(units: JsonlUnit[], maxRows: number): JsonlUnit[][] {
  const chunks: JsonlUnit[][] = [];
  let current: JsonlUnit[] = [];
  let rows = 0;
  for (const unit of units) {
    const size = 1 + unit.children.length;
    if (current.length && rows + size > maxRows) {
      chunks.push(current);
      current = [];
      rows = 0;
    }
    current.push(unit);
    rows += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
