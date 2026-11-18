import { describe, expect, it } from "vitest";
import { batchUnits, groupUnits, JsonlLineError, MAX_LINE_BYTES, OrphanRecordError, parseJsonl, readLines, type JsonlUnit } from "./jsonl";

const encoder = new TextEncoder();
async function* chunks(...parts: Array<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === "string" ? encoder.encode(part) : part;
}
const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
};
const line = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;

describe("reading lines", () => {
  it("splits across chunk boundaries, including inside a multi-byte character", async () => {
    const euro = encoder.encode("€");
    const lines = await collect(readLines(chunks("a\nb", "c\r\nprice ", euro.subarray(0, 1), euro.subarray(1), "5\nlast")));
    expect(lines).toEqual(["a", "bc", "price €5", "last"]);
  });

  it("refuses a line over the size bound instead of buffering it", async () => {
    await expect(collect(readLines(chunks("x".repeat(MAX_LINE_BYTES + 1))))).rejects.toThrow(/size bound/);
  });

  it("reports invalid JSON with its line number", async () => {
    const parsed = parseJsonl(chunks(line({ id: "a" }), "{not json}\n"));
    await expect(collect(parsed)).rejects.toMatchObject({ name: "JsonlLineError", line: 2 });
    await expect(collect(parseJsonl(chunks("[1,2]\n")))).rejects.toBeInstanceOf(JsonlLineError);
  });
});

describe("grouping records into units", () => {
  const file = [
    line({ id: "gid://shopify/Product/1", title: "Lamp" }),
    line({ id: "gid://shopify/ProductVariant/11", __parentId: "gid://shopify/Product/1" }),
    line({ id: "gid://shopify/InventoryLevel/111", __parentId: "gid://shopify/ProductVariant/11" }),
    line({ id: "gid://shopify/Metafield/12", __parentId: "gid://shopify/Product/1" }),
    line({ id: "gid://shopify/Product/2", title: "Desk" }),
    line({ id: "gid://shopify/Product/3", title: "Chair" }),
    line({ id: "gid://shopify/ProductVariant/31", __parentId: "gid://shopify/Product/3" }),
  ];

  it("keeps each top-level record with every descendant and its line span", async () => {
    const units = await collect(groupUnits(parseJsonl(chunks(...file))));
    expect(units.map((u) => [u.root.title, u.children.length, u.firstLine, u.lastLine])).toEqual([
      ["Lamp", 3, 1, 4], ["Desk", 0, 5, 5], ["Chair", 1, 6, 7],
    ]);
  });

  it("accepts children of inline objects, such as refund line items under an order's inline refunds", async () => {
    const order = [
      line({ id: "gid://shopify/Order/1", refunds: [{ id: "gid://shopify/Refund/5", createdAt: "2026-01-01" }] }),
      line({ id: "gid://shopify/LineItem/2", __parentId: "gid://shopify/Order/1" }),
      line({ quantity: 1, lineItem: { id: "gid://shopify/LineItem/2" }, __parentId: "gid://shopify/Refund/5" }),
    ];
    const units = await collect(groupUnits(parseJsonl(chunks(...order))));
    expect(units).toHaveLength(1);
    expect(units[0].children).toHaveLength(2);
  });

  it("fails loudly on a child whose parent is not in the current group", async () => {
    const ungrouped = [file[0], file[4], line({ id: "gid://shopify/ProductVariant/12", __parentId: "gid://shopify/Product/1" })];
    await expect(collect(groupUnits(parseJsonl(chunks(...ungrouped))))).rejects.toMatchObject({ name: "OrphanRecordError", line: 3 });
    await expect(collect(groupUnits(parseJsonl(chunks(file[1]))))).rejects.toBeInstanceOf(OrphanRecordError);
  });

  it("streams a large file in bounded memory", async () => {
    async function* big(): AsyncGenerator<Uint8Array> {
      for (let i = 1; i <= 50_000; i++) {
        yield encoder.encode(line({ id: `gid://shopify/Order/${i}` }) + line({ id: `gid://shopify/LineItem/${i}`, __parentId: `gid://shopify/Order/${i}` }));
      }
    }
    let units = 0;
    for await (const unit of groupUnits(parseJsonl(big()))) units += unit.children.length === 1 ? 1 : 0;
    expect(units).toBe(50_000);
  });
});

describe("batching and resuming", () => {
  const unit = (n: number, children: number, lastLine: number): JsonlUnit => ({
    root: { id: `r${n}` }, children: Array.from({ length: children }, (_, i) => ({ id: `c${n}-${i}` })), firstLine: lastLine - children, lastLine,
  });
  async function* source(): AsyncGenerator<JsonlUnit> {
    yield unit(1, 2, 3);
    yield unit(2, 0, 4);
    yield unit(3, 5, 10);
    yield unit(4, 1, 12);
  }

  it("bounds batches by rows without splitting a unit, and checkpoints at a unit's last line", async () => {
    const batches = await collect(batchUnits(source(), { maxRows: 5 }));
    expect(batches.map((b) => [b.units.map((u) => u.root.id), b.rows, b.lastLine])).toEqual([
      [["r1", "r2"], 4, 4], [["r3"], 6, 10], [["r4"], 2, 12],
    ]);
  });

  it("skips every unit committed before a resume, and only those", async () => {
    const batches = await collect(batchUnits(source(), { maxRows: 100, skipThroughLine: 4 }));
    expect(batches.map((b) => b.units.map((u) => u.root.id))).toEqual([["r3", "r4"]]);
    expect(await collect(batchUnits(source(), { maxRows: 100, skipThroughLine: 12 }))).toEqual([]);
  });
});
