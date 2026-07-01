import { clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";
import { requireUser } from "@/lib/api/require-user";
import { apiError, apiOk, apiServerError } from "@/lib/api/response";

/**
 * Strict allowlist of the publicMetadata keys a caller may set. `onboardingStep`
 * is consumed by proxy.ts for routing, so we must never let arbitrary keys or
 * values be written — `.strict()` rejects anything not listed here, preventing
 * metadata injection / tampering.
 */
const MetadataSchema = z
  .object({
    onboardingStep: z
      .enum(["connect-shopify", "connect-meta", "audit", "complete"])
      .optional(),
    shopifyStoreUrl: z.string().min(1).max(255).optional(),
  })
  .strict();

export async function POST(request: Request) {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Invalid JSON body", 400);
  }

  const parsed = MetadataSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid metadata payload", 400);
  }

  try {
    const client = await clerkClient();
    await client.users.updateUserMetadata(userId, {
      publicMetadata: parsed.data,
    });
    return apiOk({ success: true });
  } catch (error) {
    return apiServerError("update-metadata", error);
  }
}
