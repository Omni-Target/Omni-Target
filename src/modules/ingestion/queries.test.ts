import { describe, expect, it } from "vitest";
import { assertLevel1Query } from "./access";
import { BULK_QUERIES, LOCATIONS_QUERY, searchFilter } from "./queries";

/** Connections (fields selecting edges) and how deeply they nest. */
function connectionShape(query: string): { connections: number; depth: number } {
  let depth = 0;
  let maxDepth = 0;
  let connections = 0;
  const open: boolean[] = [];
  const tokens = query.match(/[{}]|\bedges\b/g) ?? [];
  for (const token of tokens) {
    if (token === "edges") {
      connections += 1;
      open.push(true);
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
    } else if (token === "{") {
      if (open.length && open[open.length - 1] === true) open[open.length - 1] = false;
      else open.push(false);
    } else {
      const wasEdges = open.pop();
      if (wasEdges === false && open.length && open[open.length - 1] === false) continue;
    }
  }
  // edges are counted once per connection; nesting is the deepest chain of connections.
  depth = 0;
  maxDepth = 0;
  const stack: Array<"edges" | "block"> = [];
  let pendingEdges = false;
  for (const token of tokens) {
    if (token === "edges") pendingEdges = true;
    else if (token === "{") {
      stack.push(pendingEdges ? "edges" : "block");
      if (pendingEdges) {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
      }
      pendingEdges = false;
    } else if (stack.pop() === "edges") depth -= 1;
  }
  return { connections, depth: maxDepth };
}

describe("bulk queries (Phase 2 task 4)", () => {
  for (const [domain, build] of Object.entries(BULK_QUERIES)) {
    // Shopify's "two levels deep" counts nested connections below the top-level one
    // (orders > returns > returnLineItems is accepted; verified live on 2026-07).
    it(`${domain}: Level 1 only, within Shopify's 5 connections and 2 nested levels`, () => {
      for (const query of [build(), build(searchFilter([["updated_at", ">=", new Date("2026-01-01T00:00:00Z")]]))]) {
        expect(() => assertLevel1Query(query)).not.toThrow();
        const shape = connectionShape(query);
        expect(shape.connections, domain).toBeLessThanOrEqual(5);
        expect(shape.depth - 1, domain).toBeLessThanOrEqual(2);
      }
    });
  }

  it("asks a shipping address for city, province and country only, and the customer for its ID only", () => {
    const orders = BULK_QUERIES.orders();
    expect(orders).toContain("shippingAddress { city provinceCode countryCodeV2 }");
    expect(orders).toContain("customer { id }");
    expect(BULK_QUERIES.customers()).not.toMatch(/defaultAddress|email|phone|firstName|lastName/);
  });

  it("embeds history windows and watermarks as quoted Shopify search filters", () => {
    const filter = searchFilter([["processed_at", ">=", new Date("2024-11-18T00:00:00Z")], ["processed_at", "<", new Date("2025-02-18T00:00:00Z")]]);
    expect(filter).toBe("processed_at:>='2024-11-18T00:00:00.000Z' processed_at:<'2025-02-18T00:00:00.000Z'");
    expect(BULK_QUERIES.orders(filter)).toContain(`orders(query: ${JSON.stringify(filter)})`);
  });

  it("keeps the paginated locations query within the guard", () => {
    expect(() => assertLevel1Query(LOCATIONS_QUERY)).not.toThrow();
  });
});
