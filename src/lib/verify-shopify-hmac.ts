import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verifies a Shopify webhook request using its HMAC-SHA256 signature.
 *
 * Shopify signs every webhook with a base64-encoded HMAC-SHA256 digest of the
 * raw request body, using the app's webhook signing secret. This utility
 * performs a constant-time comparison to prevent timing attacks.
 *
 * @param rawBody   - The raw UTF-8 request body (must be read before any parsing)
 * @param hmacHeader - The value of the `X-Shopify-Hmac-SHA256` header
 * @param secret    - The webhook signing secret (`SHOPIFY_WEBHOOK_SECRET`)
 * @returns `true` if the signature is valid, `false` otherwise
 */
export async function verifyShopifyHmac(
  rawBody: string,
  hmacHeader: string,
  secret: string
): Promise<boolean> {
  const digest = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const digestBuf = Buffer.from(digest, "utf8");
  const headerBuf = Buffer.from(hmacHeader, "utf8");

  // timingSafeEqual throws on a length mismatch; compare lengths first so the
  // comparison itself stays constant-time and we never rely on a thrown
  // exception for control flow. A length mismatch is always a failed signature.
  if (digestBuf.length !== headerBuf.length) {
    return false;
  }

  try {
    return timingSafeEqual(digestBuf, headerBuf);
  } catch {
    return false;
  }
}
