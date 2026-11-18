import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asBytea, redactionDigests, subjectDigest, suppressionKey } from "./suppression";

const key = randomBytes(32);

describe("redaction suppression digests (Phase 2 decision 5)", () => {
  it("is a keyed HMAC of shop, type and ID, so equal inputs always match and nothing is stored in clear", () => {
    const digest = subjectDigest(key, 954889, "customer", 77);
    expect(digest).toEqual(createHmac("sha256", key).update("954889:customer:77").digest());
    expect(digest).toHaveLength(32);
    expect(subjectDigest(key, 954889, "customer", 77)).toEqual(digest);
  });

  it("separates shops, subject types and keys", () => {
    const base = subjectDigest(key, 1, "customer", 5);
    expect(subjectDigest(key, 2, "customer", 5)).not.toEqual(base);
    expect(subjectDigest(key, 1, "order", 5)).not.toEqual(base);
    expect(subjectDigest(randomBytes(32), 1, "customer", 5)).not.toEqual(base);
  });

  it("formats digests as PostgREST bytea literals, deduplicating orders", () => {
    const digests = redactionDigests(1, { customerId: 5, orderIds: [9, 9, 10] }, key);
    expect(digests.customerDigest).toBe(asBytea(subjectDigest(key, 1, "customer", 5)));
    expect(digests.customerDigest).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(digests.orderDigests).toHaveLength(2);
    expect(redactionDigests(1, { customerId: null, orderIds: [] }, key)).toEqual({ customerDigest: null, orderDigests: [], keyVersion: 1 });
  });

  it("refuses a missing or short key without echoing it", () => {
    expect(() => suppressionKey(undefined)).toThrow(/not configured/);
    expect(() => suppressionKey("   ")).toThrow(/not configured/);
    const short = Buffer.from("too-short").toString("base64");
    expect(() => suppressionKey(short)).toThrow(/at least 32 bytes/);
    try {
      suppressionKey(short);
    } catch (error) {
      expect((error as Error).message).not.toContain(short);
    }
    expect(suppressionKey(key.toString("base64"))).toEqual(key);
  });
});
