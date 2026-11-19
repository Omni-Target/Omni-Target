import { describe, expect, it } from "vitest";
import type { JsonlUnit } from "./jsonl";
import { IncompleteResultError, streamImport } from "./stream-import";

const encoder = new TextEncoder();
const file = (orders: number, linesEach: number) => {
  const out: string[] = [];
  for (let o = 1; o <= orders; o++) {
    out.push(JSON.stringify({ id: `gid://shopify/Order/${o}` }));
    for (let l = 1; l <= linesEach; l++) out.push(JSON.stringify({ id: `gid://shopify/LineItem/${o}${l}`, __parentId: `gid://shopify/Order/${o}` }));
  }
  return out;
};
async function* bytes(lines: string[]): AsyncGenerator<Uint8Array> {
  for (const line of lines) yield encoder.encode(`${line}\n`);
}
function recorder() {
  const written: JsonlUnit[][] = [];
  const checkpoints: number[] = [];
  return { written, checkpoints, write: async (u: JsonlUnit[]) => { written.push(u); }, checkpoint: async (n: number) => { checkpoints.push(n); } };
}

describe("streaming a bulk result into the mirror (Phase 2 task 6)", () => {
  it("writes every unit in bounded batches, checkpointing after each", async () => {
    const lines = file(5, 2);
    const r = recorder();
    const result = await streamImport({ source: bytes(lines), expectedObjects: lines.length, maxRows: 6, ...r });
    expect(result).toEqual({ records: 15, units: 5, batches: 3, lastLine: 15 });
    expect(r.written.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(r.checkpoints).toEqual([6, 12, 15]);
  });

  it("never writes the last unit of a file that ended short, so a cut-off record cannot look like deletions", async () => {
    const lines = file(4, 2);
    const truncated = lines.slice(0, 11); // the fourth order has lost a line item
    const r = recorder();
    await expect(streamImport({ source: bytes(truncated), expectedObjects: lines.length, maxRows: 3, ...r }))
      .rejects.toBeInstanceOf(IncompleteResultError);
    expect(r.written.flat().map((u) => u.root.id)).toEqual(["gid://shopify/Order/1", "gid://shopify/Order/2", "gid://shopify/Order/3"]);
    expect(r.checkpoints.at(-1)).toBe(9);
  });

  it("resumes after its checkpoint without writing anything twice", async () => {
    const lines = file(4, 1);
    const first = recorder();
    await streamImport({ source: bytes(lines), expectedObjects: lines.length, maxRows: 2, ...first });
    const resumed = recorder();
    const result = await streamImport({ source: bytes(lines), expectedObjects: lines.length, maxRows: 2, skipThroughLine: 4, ...resumed });
    expect(resumed.written.flat().map((u) => u.root.id)).toEqual(["gid://shopify/Order/3", "gid://shopify/Order/4"]);
    expect(result.lastLine).toBe(8);
  });

  it("accepts an empty result and an operation with no objects", async () => {
    const r = recorder();
    expect(await streamImport({ source: bytes([]), expectedObjects: 0, maxRows: 10, ...r })).toEqual({ records: 0, units: 0, batches: 0, lastLine: 0 });
  });
});
