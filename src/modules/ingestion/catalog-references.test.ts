import { describe, expect, it, vi } from "vitest";
import { assertLevel1Query } from "./access";
import { syncCatalogDefinitions, syncReferencedMetaobjects, type ReferenceWrites } from "./catalog-references";
import { METAFIELD_DEFINITIONS, METAOBJECT_DEFINITIONS, METAOBJECTS_BY_ID, VARIANT_METAFIELDS_PAGE } from "./queries";

const page = <T,>(nodes: T[], next: string | null = null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } });

function writes(due: number[][] = []) {
  const stored = new Set<number>();
  const w = {
    writeCatalogDefinitions: vi.fn(async () => ({ metafield_definitions: 1 })),
    writeMetaobjects: vi.fn(async (_shop: number, rows: Array<{ shopify_id: number }>, deleted: number[]) => {
      rows.forEach((r) => stored.add(r.shopify_id));
      return { metaobjects: rows.length, metaobjects_deleted: deleted.length };
    }),
    // Each call answers the next scripted list: what the database would report as still due.
    catalogReferenceIds: vi.fn(async () => due.shift() ?? []),
    metaobjectDisplayKeys: vi.fn(async () => new Map([["shopify--size", "label"]])),
  };
  return { w: w satisfies ReferenceWrites, stored };
}

describe("catalog references (Phase 3, task 2)", () => {
  it("queries Level 1 data only, with bounded pages", () => {
    for (const query of [METAFIELD_DEFINITIONS, METAOBJECT_DEFINITIONS, METAOBJECTS_BY_ID, VARIANT_METAFIELDS_PAGE]) {
      expect(() => assertLevel1Query(query)).not.toThrow();
      for (const [, first] of query.matchAll(/first: (\d+)/g)) expect(Number(first)).toBeLessThanOrEqual(250);
    }
  });

  it("replaces definitions with Shopify's full lists, product and variant metafields and metaobjects", async () => {
    const gql = vi.fn(async (query: string, variables: Record<string, unknown> = {}) => {
      if (query.includes("MetafieldDefinitions")) {
        if (variables.ownerType === "PRODUCTVARIANT") return { metafieldDefinitions: page([{ id: "gid://shopify/MetafieldDefinition/3", namespace: "specs", key: "length", name: "Length", type: { name: "dimension" } }]) };
        return variables.after
          ? { metafieldDefinitions: page([{ id: "gid://shopify/MetafieldDefinition/2", namespace: "shopify", key: "size", name: "Size", type: { name: "list.metaobject_reference" } }]) }
          : { metafieldDefinitions: page([{ id: "gid://shopify/MetafieldDefinition/1", namespace: "test_data", key: "length", name: "Length", type: { name: "dimension" } }], "next") };
      }
      return { metaobjectDefinitions: page([{ id: "gid://shopify/MetaobjectDefinition/4", type: "shopify--size", name: "Size", displayNameKey: "label", fieldDefinitions: [] }]) };
    });
    const { w } = writes();
    await syncCatalogDefinitions(gql as never, 2, w);
    const batch = (w.writeCatalogDefinitions.mock.calls[0] as unknown[])[1] as { metafieldDefinitions: Array<{ owner_type: string; key: string }>; metaobjectDefinitions: Array<{ type: string }> };
    expect(batch.metafieldDefinitions.map((d) => `${d.owner_type}:${d.key}`)).toEqual(["product:length", "product:size", "variant:length"]);
    expect(batch.metaobjectDefinitions.map((d) => d.type)).toEqual(["shopify--size"]);
  });

  it("reads due metaobjects in batches, records those Shopify no longer has, and never rereads one in a run", async () => {
    const gql = vi.fn(async (_query: string, variables: Record<string, unknown> = {}) => ({
      nodes: (variables.ids as string[]).map((gid) => {
        const id = Number(gid.split("/").pop());
        return id === 13 ? null : { id: gid, type: "shopify--size", handle: `h${id}`, updatedAt: "2026-11-01T00:00:00Z", fields: [{ key: "label", value: `Size ${id}` }] };
      }),
    }));
    // The second call still reports 11 as due (an older copy Shopify returned unchanged): it is not read again.
    const { w, stored } = writes([[11, 12, 13], [11, 14], [11]]);
    const report = await syncReferencedMetaobjects(gql as never, 2, w);
    expect(gql).toHaveBeenCalledTimes(2);
    expect((gql.mock.calls[1][1] as { ids: string[] }).ids).toEqual(["gid://shopify/Metaobject/14"]);
    expect([...stored].sort()).toEqual([11, 12, 14]);
    expect(w.writeMetaobjects.mock.calls[0][2]).toEqual([13]);
    const first = (w.writeMetaobjects.mock.calls[0][1] as Array<{ shopify_id: number; display_name: string }>)[0];
    expect(first).toMatchObject({ shopify_id: 11, display_name: "Size 11" });
    expect(report).toEqual({ read: 4, written: 3, deleted: 1, complete: true });
  });

  it("stops at its batch bound and reports itself incomplete", async () => {
    let next = 1;
    const { w } = writes();
    w.catalogReferenceIds.mockImplementation(async () => [next++]);
    const gql = vi.fn(async () => ({ nodes: [null] }));
    expect(await syncReferencedMetaobjects(gql as never, 2, w, { maxBatches: 3 })).toMatchObject({ read: 3, complete: false });
  });
});
