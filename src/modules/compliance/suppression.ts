import { createHmac } from "node:crypto";

/**
 * Redaction suppression digests (Phase 2, task 2; migration 0031).
 *
 * A customer or order named by customers/redact is remembered only as
 * HMAC-SHA256(key, "<shopify shop id>:<type>:<shopify id>"), so the
 * suppression list holds no usable identifier. Every ingestion path computes
 * the same digest for what it is about to store and drops suppressed subjects.
 *
 * The key (REDACTION_SUPPRESSION_KEY, base64, at least 32 bytes) must never be
 * lost or replaced without keeping the old one: a digest made under a lost
 * key can no longer be matched, and the redacted subject could return.
 */
export type SubjectType = "customer" | "order";

export const SUPPRESSION_KEY_VERSION = 1;

export class SuppressionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuppressionKeyError";
  }
}

/** The configured key. Throws when it is missing or too short, never echoing it. */
export function suppressionKey(value: string | undefined = process.env.REDACTION_SUPPRESSION_KEY): Buffer {
  if (!value || !value.trim()) throw new SuppressionKeyError("REDACTION_SUPPRESSION_KEY is not configured");
  const key = Buffer.from(value.trim(), "base64");
  if (key.length < 32) throw new SuppressionKeyError("REDACTION_SUPPRESSION_KEY must be at least 32 bytes, base64-encoded");
  return key;
}

/** What a digest can name: a suppressed subject, or a refund (0042's ledger of history arrivals). */
export type DigestSubject = SubjectType | "refund";

export function subjectDigest(key: Buffer, shopifyShopId: number, type: DigestSubject, shopifyId: number): Buffer {
  return createHmac("sha256", key).update(`${shopifyShopId}:${type}:${shopifyId}`).digest();
}

/** A digest as PostgREST accepts it for a bytea parameter. */
export const asBytea = (digest: Buffer): string => `\\x${digest.toString("hex")}`;

export interface SuppressionDigests {
  customerDigest: string | null;
  orderDigests: string[];
  keyVersion: number;
}

/** The digests customers/redact records for the customer and orders it names. */
export function redactionDigests(
  shopifyShopId: number,
  subject: { customerId: number | null; orderIds: number[] },
  key: Buffer = suppressionKey(),
): SuppressionDigests {
  return {
    customerDigest: subject.customerId === null ? null : asBytea(subjectDigest(key, shopifyShopId, "customer", subject.customerId)),
    orderDigests: [...new Set(subject.orderIds)].map((id) => asBytea(subjectDigest(key, shopifyShopId, "order", id))),
    keyVersion: SUPPRESSION_KEY_VERSION,
  };
}
