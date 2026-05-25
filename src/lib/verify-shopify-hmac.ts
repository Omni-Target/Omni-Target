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

  try {
    // timingSafeEqual requires both Buffers to be the same length;
    // a length mismatch itself leaks nothing but throws — catch it.
    return timingSafeEqual(
      Buffer.from(digest, "utf8"),
      Buffer.from(hmacHeader, "utf8")
    );
  } catch {
    return false;
  }
}
