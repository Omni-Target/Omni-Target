import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withCustomerDigests, withOrderDigests } from "./digests";
import type { CustomerRow, OrderRow } from "./mappers";

const key = randomBytes(32);
const hmac = (message: string) => createHmac("sha256", key).update(message).digest("hex");

describe("suppression digests on ingested rows (decision 5)", () => {
  it("adds the customer's and the order's digest, matching what customers/redact records", () => {
    const order = { shopify_id: 601, customer_shopify_id: 501 } as OrderRow;
    const guest = { shopify_id: 602, customer_shopify_id: null } as OrderRow;
    expect(withOrderDigests([order, guest], key, 954889)).toEqual([
      { ...order, customer_digest: hmac("954889:customer:501"), order_digest: hmac("954889:order:601") },
      { ...guest, customer_digest: null, order_digest: hmac("954889:order:602") },
    ]);
  });

  it("adds each customer's digest", () => {
    const customer = { shopify_id: 501 } as CustomerRow;
    expect(withCustomerDigests([customer], key, 954889)).toEqual([{ ...customer, digest: hmac("954889:customer:501") }]);
  });
});
