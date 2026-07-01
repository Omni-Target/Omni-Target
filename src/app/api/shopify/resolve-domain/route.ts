import { z } from "zod";
import { resolveShopifyDomain } from "@/lib/shopify-resolver";
import { requireUser } from "@/lib/api/require-user";
import { apiError, apiServerError } from "@/lib/api/response";

const BodySchema = z.object({
  domain: z.string().min(1).max(255),
});

export async function POST(request: Request) {
  // Defense-in-depth: proxy.ts already gates this, but verify auth here too.
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;

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

  try {
    const result = await resolveShopifyDomain(parsed.data.domain);
    return Response.json(result);
  } catch (error) {
    return apiServerError("resolve-domain", error);
  }
}
