import { z } from "zod";
import { requireUser } from "@/lib/api/require-user";
import { apiError, apiOk, apiServerError } from "@/lib/api/response";
import { selectMetaPage } from "@/modules/credentials/meta";
import { currentWorkspaceFor } from "@/modules/workspaces/current";

const BodySchema = z.object({
  meta_page_id: z.string().min(1).max(200),
  // Accepted for backwards-compatibility but ignored — the name is sourced from
  // the stored page record, never trusted from the client.
  meta_page_name: z.string().max(500).optional(),
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
    return apiError("Invalid request: meta_page_id is required", 400);
  }
  const { meta_page_id } = parsed.data;

  try {
    // Ownership check, in the database: the page must be one of this
    // workspace's connected Meta pages. Its token is fetched fresh from Meta
    // and stored encrypted for this workspace only.
    const workspace = await currentWorkspaceFor(userId);
    if (!workspace) return apiError("Page not found for this user", 403);
    await selectMetaPage(workspace.workspace_id, userId, meta_page_id);
    return apiOk({ success: true });
  } catch (error) {
    if (error instanceof Error && /meta_asset_not_found|workspace_access_denied/.test(error.message)) {
      return apiError("Page not found for this user", 403);
    }
    return apiServerError("select-page", error);
  }
}
