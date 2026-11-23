import type { Gql } from "./bulk";
import { mapMetafieldDefinition, mapMetaobject, mapMetaobjectDefinition, type MetafieldDefinitionRow, type MetaobjectDefinitionRow } from "./mappers";
import { METAFIELD_DEFINITIONS, METAOBJECT_DEFINITIONS, METAOBJECTS_BY_ID } from "./queries";
import type * as Writes from "./writes";

/**
 * Catalog references (Phase 3, task 2): the shop's metafield and metaobject
 * definitions, and the metaobjects its products and variants reference (for
 * example the standard category attributes, such as size or material, and
 * merchant compatibility lists). Run after the catalog import, after product
 * webhooks (missing references only), and daily (stale references too).
 * Bounded: definitions are a few pages; metaobjects are read 100 at a time.
 */
export type ReferenceWrites = Pick<typeof Writes, "writeCatalogDefinitions" | "writeMetaobjects" | "catalogReferenceIds" | "metaobjectDisplayKeys">;

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };
const MAX_DEFINITION_PAGES = 8;
const BATCH = 100;

async function allNodes(gql: Gql, query: string, field: string, variables: Record<string, unknown> = {}): Promise<unknown[]> {
  const nodes: unknown[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_DEFINITION_PAGES; page++) {
    const data: Record<string, Page<unknown>> = await gql(query, { ...variables, after });
    nodes.push(...data[field].nodes);
    if (!data[field].pageInfo.hasNextPage) return nodes;
    after = data[field].pageInfo.endCursor;
  }
  throw new Error(`${field}: more than ${MAX_DEFINITION_PAGES} pages`);
}

export async function syncCatalogDefinitions(gql: Gql, shopKey: number, writes: ReferenceWrites): Promise<Record<string, number>> {
  const metafieldDefinitions: MetafieldDefinitionRow[] = [];
  for (const [ownerType, owner] of [["PRODUCT", "product"], ["PRODUCTVARIANT", "variant"]] as const) {
    for (const node of await allNodes(gql, METAFIELD_DEFINITIONS, "metafieldDefinitions", { ownerType })) {
      const row = mapMetafieldDefinition(node, owner);
      if (row) metafieldDefinitions.push(row);
    }
  }
  const metaobjectDefinitions = (await allNodes(gql, METAOBJECT_DEFINITIONS, "metaobjectDefinitions"))
    .map(mapMetaobjectDefinition).filter((d): d is MetaobjectDefinitionRow => d !== null);
  return writes.writeCatalogDefinitions(shopKey, { metafieldDefinitions, metaobjectDefinitions });
}

export interface MetaobjectSyncReport { read: number; written: number; deleted: number; complete: boolean }

/** Reads referenced metaobjects that are missing (and, with staleBefore, those read before it), in batches. */
export async function syncReferencedMetaobjects(
  gql: Gql, shopKey: number, writes: ReferenceWrites, { staleBefore = null, maxBatches = 40 }: { staleBefore?: Date | null; maxBatches?: number } = {},
): Promise<MetaobjectSyncReport> {
  const report: MetaobjectSyncReport = { read: 0, written: 0, deleted: 0, complete: false };
  const displayKeys = await writes.metaobjectDisplayKeys(shopKey);
  const attempted = new Set<number>();
  for (let batch = 0; batch < maxBatches; batch++) {
    // A metaobject Shopify returns unchanged and older than the stored one stays due; never read it twice in a run.
    const ids = (await writes.catalogReferenceIds(shopKey, staleBefore, BATCH)).filter((id) => !attempted.has(id));
    if (!ids.length) {
      report.complete = true;
      break;
    }
    ids.forEach((id) => attempted.add(id));
    const { nodes } = await gql<{ nodes: Array<Record<string, unknown> | null> }>(METAOBJECTS_BY_ID, { ids: ids.map((id) => `gid://shopify/Metaobject/${id}`) });
    const rows = nodes.flatMap((node) => {
      const row = node ? mapMetaobject(node, displayKeys.get(String(node.type)) ?? null) : null;
      return row ? [row] : [];
    });
    // nodes(ids:) answers in order, with null for an ID Shopify no longer has.
    const deleted = ids.filter((_, index) => nodes[index] === null || nodes[index] === undefined);
    const written = await writes.writeMetaobjects(shopKey, rows, deleted);
    report.read += ids.length;
    report.written += Number(written.metaobjects ?? 0);
    report.deleted += Number(written.metaobjects_deleted ?? 0);
  }
  return report;
}

export async function syncCatalogReferences(
  gql: Gql, shopKey: number, writes: ReferenceWrites, options: { staleBefore?: Date | null; maxBatches?: number } = {},
): Promise<{ definitions: Record<string, number>; metaobjects: MetaobjectSyncReport }> {
  const definitions = await syncCatalogDefinitions(gql, shopKey, writes);
  return { definitions, metaobjects: await syncReferencedMetaobjects(gql, shopKey, writes, options) };
}
