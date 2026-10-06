import { z } from "zod";
import { resolveShopifyDomain } from "@/lib/shopify-resolver";
import { validateShopifyInput } from "@/lib/domain-validation";
import { apiError, apiServerError } from "@/lib/api/response";

const BodySchema = z.object({
  domain: z.string().min(1).max(255),
});

export async function POST(request: Request) {
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
