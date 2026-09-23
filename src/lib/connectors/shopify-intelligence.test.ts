import { describe, expect, it } from "vitest";
import { normalizeShopifyQlRows } from "./shopify-intelligence";

describe("normalizeShopifyQlRows", () => {
  it("normalizes ShopifyQL array rows using returned column names", () => {
    expect(
      normalizeShopifyQlRows({
        columns: [{ name: "sessions" }, { name: "conversion_rate" }],
        rows: [["100", "2.5%"]],
      }),
    ).toEqual([{ sessions: "100", conversion_rate: "2.5%" }]);
  });

  it("preserves object rows and ignores unusable rows", () => {
    expect(
      normalizeShopifyQlRows({ rows: [{ sessions: 12 }, "bad", null] }),
    ).toEqual([{ sessions: 12 }]);
  });
});
