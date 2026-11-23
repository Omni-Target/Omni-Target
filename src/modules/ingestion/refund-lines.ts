import type { Gql } from "./bulk";
import { mapRefundNode, type RefundLineItemRow } from "./mappers";
import { REFUND_LINE_ITEMS_PAGE, REFUNDS_BY_ID } from "./queries";
import type * as Writes from "./writes";

/**
 * Refund line items (Phase 3, task 4). A bulk export cannot nest a refund's
 * lines inside an order's refunds, so stored refunds are read by ID afterwards,
 * 10 a call, each with the return it settles; lines beyond the first 50 are
 * paged. A refund Shopify no longer has is marked read with no lines, so it is
 * never due again. Run after the orders import, after order webhooks, and daily.
 */
export type RefundLineWrites = Pick<typeof Writes, "writeRefundLines" | "refundLinesDue">;

type Raw = Record<string, unknown>;
type Connection = { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; edges?: Array<{ node?: unknown }> };
const PER_CALL = 10;
const MAX_LINE_PAGES = 15;

export interface RefundLineReport { refunds: number; lines: number; gone: number; complete: boolean }

export async function syncRefundLines(
  gql: Gql, shopKey: number, writes: RefundLineWrites,
  { maxBatches = 50, onBatch }: { maxBatches?: number; onBatch?: () => Promise<void> } = {},
): Promise<RefundLineReport> {
  const report: RefundLineReport = { refunds: 0, lines: 0, gone: 0, complete: false };
  const attempted = new Set<number>();
  for (let batch = 0; batch < maxBatches; batch++) {
    const due = (await writes.refundLinesDue(shopKey, 100)).filter((id) => !attempted.has(id));
    if (!due.length) {
      report.complete = true;
      break;
    }
    due.forEach((id) => attempted.add(id));
    for (let i = 0; i < due.length; i += PER_CALL) {
      // Written per call: 10 refunds and their lines stay well inside a write's 2,000 rows.
      const refunds: Array<{ shopify_id: number; return_shopify_id: number | null }> = [];
      const lines: RefundLineItemRow[] = [];
      const ids = due.slice(i, i + PER_CALL);
      const { nodes } = await gql<{ nodes: Array<Raw | null> }>(REFUNDS_BY_ID, { ids: ids.map((id) => `gid://shopify/Refund/${id}`) });
      for (let k = 0; k < ids.length; k++) {
        const node = nodes[k];
        if (!node) {
          refunds.push({ shopify_id: ids[k], return_shopify_id: null });
          report.gone += 1;
          continue;
        }
        const connection = (node.refundLineItems ?? {}) as Connection;
        const lineNodes = (connection.edges ?? []).map((edge) => edge.node);
        let info = connection.pageInfo ?? {};
        for (let page = 0; info.hasNextPage && info.endCursor && page < MAX_LINE_PAGES; page++) {
          const next = (await gql<{ node: Raw | null }>(REFUND_LINE_ITEMS_PAGE, { id: node.id, after: info.endCursor })).node;
          const more = (next?.refundLineItems ?? {}) as Connection;
          lineNodes.push(...(more.edges ?? []).map((edge) => edge.node));
          info = more.pageInfo ?? {};
        }
        if (info.hasNextPage) throw new Error(`refund ${ids[k]}: more than ${MAX_LINE_PAGES} pages of line items`);
        const mapped = mapRefundNode(node, lineNodes);
        if (!mapped) continue;
        refunds.push(mapped.refund);
        lines.push(...mapped.lines);
      }
      if (refunds.length + lines.length > 2_000) throw new Error(`refunds ${ids.join(",")}: more line items than one write holds`);
      const written = await writes.writeRefundLines(shopKey, refunds, lines);
      report.refunds += Number(written.refunds ?? 0);
      report.lines += Number(written.lines ?? 0);
    }
    await onBatch?.();
  }
  return report;
}
