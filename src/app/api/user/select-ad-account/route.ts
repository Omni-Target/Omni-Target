import { z } from "zod";
import { requireUser } from "@/lib/api/require-user";
import { apiError, apiOk, apiServerError } from "@/lib/api/response";
import { selectMetaAdAccount } from "@/modules/credentials/meta";
import { currentWorkspaceFor } from "@/modules/workspaces/current";

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
    // Ownership check, in the database: the account must be one of this
    // workspace's connected Meta ad accounts. Prevents IDOR via a guessed id.
    const workspace = await currentWorkspaceFor(userId);
    if (!workspace) return apiError("Ad account not found for this user", 403);
    await selectMetaAdAccount(workspace.workspace_id, userId, adAccountId);
    return apiOk({ success: true });
  } catch (error) {
    if (error instanceof Error && /meta_asset_not_found|workspace_access_denied/.test(error.message)) {
      return apiError("Ad account not found for this user", 403);
    }
    return apiServerError("select-ad-account", error);
  }
}
