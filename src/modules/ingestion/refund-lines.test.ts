import { describe, expect, it, vi } from "vitest";
import { assertLevel1Query } from "./access";
import { REFUND_LINE_ITEMS_PAGE, REFUNDS_BY_ID } from "./queries";
import { syncRefundLines, type RefundLineWrites } from "./refund-lines";

type Raw = Record<string, unknown>;
const line = (id: number, quantity = 1) => ({ node: { id: `gid://shopify/RefundLineItem/${id}`, quantity, restockType: "NO_RESTOCK", lineItem: { id: "gid://shopify/LineItem/1" } } });

function writes(due: number[][]) {
  const w = {
    refundLinesDue: vi.fn(async () => due.shift() ?? []),
    writeRefundLines: vi.fn(async (_shop: number, refunds: unknown[], lines: unknown[]) => ({ refunds: refunds.length, lines: lines.length })),
  };
  return w satisfies RefundLineWrites;
}

describe("refund line items (Phase 3, task 4)", () => {
  it("reads Level 1 fields only", () => {
    for (const query of [REFUNDS_BY_ID, REFUND_LINE_ITEMS_PAGE]) expect(() => assertLevel1Query(query)).not.toThrow();
  });

  it("reads due refunds ten a call, pages long refunds, marks refunds Shopify no longer has, and writes per call", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => 100 + i);
    const gql = vi.fn(async (query: string, variables: Raw = {}) => {
      if (query.includes("RefundLineItems")) {
        return { node: { id: variables.id, refundLineItems: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [line(999)] } } };
      }
      return { nodes: (variables.ids as string[]).map((gid) => {
        const id = Number(gid.split("/").pop());
        if (id === 105) return null;
        return { id: gid, return: id === 100 ? { id: "gid://shopify/Return/7" } : null,
          refundLineItems: { pageInfo: { hasNextPage: id === 101, endCursor: id === 101 ? "c" : null }, edges: [line(id * 10)] } };
      }) };
    });
    const w = writes([ids, [100]]);
    const report = await syncRefundLines(gql as never, 2, w);
    expect(gql.mock.calls.filter(([q]) => (q as string).includes("RefundsById")).map(([, v]) => (v as { ids: string[] }).ids.length)).toEqual([10, 2]);
    expect(w.writeRefundLines).toHaveBeenCalledTimes(2);
    const [, refunds, lines] = w.writeRefundLines.mock.calls[0] as unknown as [number, Array<{ shopify_id: number; return_shopify_id: number | null }>, Array<{ shopify_id: number; refund_shopify_id: number }>];
    expect(refunds.find((r) => r.shopify_id === 100)).toEqual({ shopify_id: 100, return_shopify_id: 7 });
    // Gone in Shopify: marked read, with no lines.
    expect(refunds.find((r) => r.shopify_id === 105)).toEqual({ shopify_id: 105, return_shopify_id: null });
    expect(lines.filter((l) => l.refund_shopify_id === 101).map((l) => l.shopify_id)).toEqual([1010, 999]);
    // 100 came back due (an older copy): not read twice in one run.
    expect(report).toEqual({ refunds: 12, lines: 12, gone: 1, complete: true });
  });

  it("stops at its batch bound, heartbeats between batches, and refuses a refund too large for one write", async () => {
    let next = 1;
    const w = writes([]);
    w.refundLinesDue.mockImplementation(async () => [next++]);
    const onBatch = vi.fn(async () => {});
    const gql = vi.fn(async () => ({ nodes: [null] }));
    expect(await syncRefundLines(gql as never, 2, w, { maxBatches: 3, onBatch })).toMatchObject({ refunds: 3, complete: false });
    expect(onBatch).toHaveBeenCalledTimes(3);

    const huge = vi.fn(async (query: string) => query.includes("RefundLineItems")
      ? { node: { refundLineItems: { pageInfo: { hasNextPage: false, endCursor: null }, edges: Array.from({ length: 100 }, (_, i) => line(5000 + i)) } } }
      : { nodes: [{ id: "gid://shopify/Refund/1", refundLineItems: { pageInfo: { hasNextPage: true, endCursor: "c" }, edges: Array.from({ length: 2000 }, (_, i) => line(i + 1)) } }] });
    await expect(syncRefundLines(huge as never, 2, writes([[1]]))).rejects.toThrow(/more line items than one write holds/);
  });
});
