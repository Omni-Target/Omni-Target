import { z } from "zod";
import { getUserIntegration, updateUserIntegration } from "@/lib/db";
import { requireUser } from "@/lib/api/require-user";
import { apiError, apiOk, apiServerError } from "@/lib/api/response";

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
    // Ownership check: the requested page must belong to this user's connected
    // Meta pages. The display name is taken from the stored record, not the
    // request body, so it cannot be spoofed.
    const integration = await getUserIntegration(userId);
    const pages: Array<{ id?: string; name?: string }> = Array.isArray(
      integration?.meta_pages
    )
      ? integration.meta_pages
      : [];

    const page = pages.find((candidate) => candidate?.id === meta_page_id);
    if (!page) {
      return apiError("Page not found for this user", 403);
    }

    await updateUserIntegration(userId, {
      meta_page_id: page.id,
      meta_page_name: page.name ?? null,
    });

    return apiOk({ success: true });
  } catch (error) {
    return apiServerError("select-page", error);
  }
}
