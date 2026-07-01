import { z } from "zod";
import { getUserIntegration, updateUserIntegration } from "@/lib/db";
import { requireUser } from "@/lib/api/require-user";
import { apiError, apiOk, apiServerError } from "@/lib/api/response";

const BodySchema = z.object({
  adAccountId: z.string().min(1).max(200),
});

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

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid request: adAccountId is required", 400);
  }
  const { adAccountId } = parsed.data;

  try {
    // Ownership check: the requested ad account must belong to this user's
    // connected Meta accounts. Prevents IDOR via a guessed/forged account id.
    const integration = await getUserIntegration(userId);
    const accounts: Array<{ id?: string }> = Array.isArray(
      integration?.meta_ad_accounts
    )
      ? integration.meta_ad_accounts
      : [];

    if (!accounts.some((account) => account?.id === adAccountId)) {
      return apiError("Ad account not found for this user", 403);
    }

    await updateUserIntegration(userId, {
      meta_selected_account_id: adAccountId,
      meta_ad_account_id: adAccountId,
    });

    return apiOk({ success: true });
  } catch (error) {
    return apiServerError("select-ad-account", error);
  }
}
