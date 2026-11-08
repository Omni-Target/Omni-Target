import { z } from "zod";
import { resolveShopifyDomain } from "@/lib/shopify-resolver";
import { validateShopifyInput } from "@/lib/domain-validation";
import { apiError, apiServerError } from "@/lib/api/response";
import { enforceRateLimit } from "@/lib/api/rate-limit";

const BodySchema = z.object({
  domain: z.string().min(1).max(255),
});

/** Client IP for rate limiting (Vercel sets x-forwarded-for to the real client). */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

/**
 * Public (pre-sign-up) store-domain check. SEC-07: rate-limited per client IP
 * because every call makes outbound requests; the resolver itself only
 * contacts DNS-validated public hosts (see src/lib/net/safe-fetch.ts).
 */
export async function POST(request: Request) {
  const limited = await enforceRateLimit({
    action: "shopify:resolve-domain",
    identifier: `ip:${clientIp(request)}`,
    limit: 20,
    windowSeconds: 600,
  });
  if (!limited.ok) return limited.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError("Invalid JSON body", 400);
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError("Domain required", 400);
  }

  const validation = validateShopifyInput(parsed.data.domain);
  if (!validation.isValid) {
    return Response.json({
      isShopify: false,
      myshopifyDomain: null,
      error: validation.error || "Please enter a valid domain (e.g., yourstore.com or store.myshopify.com).",
    });
  }

  try {
    const result = await resolveShopifyDomain(validation.normalized);
    return Response.json(result);
  } catch (error) {
    return apiServerError("resolve-domain", error);
  }
}
