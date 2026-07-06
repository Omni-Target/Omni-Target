import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { getCampaignById, updateCampaign, selectBriefVersion } from "@/lib/db";

interface FinalizeBody {
  versionId?: string | null;
  copy?: {
    headline?: string | null;
    primaryText?: string | null;
    description?: string | null;
    cta?: string | null;
    copywriterNote?: string | null;
  };
  // Full context needed to render the brief page + rebuild the PDF (aiInsights,
  // storeInsights, selected CTA, strategy/duration, gateway insight, etc.).
  briefData?: unknown;
  // Optional lifecycle marker (e.g. "complete" when the user finalizes).
  status?: string;
}

/**
 * Finalize a brief session: mark the chosen variation selected and persist the
 * brief context so /campaigns/[id] can render it and re-export the PDF. Scoped
 * to the owner — a campaign the caller doesn't own returns 404.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;
  const { id } = await params;

  const campaign = await getCampaignById(userId!, id);
  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body: FinalizeBody = await request.json().catch(() => ({}));

  // Mark the chosen variation as selected (clears the others). Best-effort.
  if (body.versionId) {
    await selectBriefVersion(userId!, id, body.versionId);
  }

  const patch: Record<string, unknown> = {};
  if (body.copy) {
    patch.headline = body.copy.headline ?? null;
    patch.primary_text = body.copy.primaryText ?? null;
    patch.description = body.copy.description ?? null;
    patch.cta = body.copy.cta ?? null;
    patch.copywriter_note = body.copy.copywriterNote ?? null;
  }
  if (body.briefData !== undefined) {
    patch.brief_data = body.briefData;
  }
  if (body.status) {
    patch.status = body.status;
  }
  if (Object.keys(patch).length > 0) {
    const ok = await updateCampaign(userId!, id, patch);
    if (!ok) {
      return NextResponse.json({ error: "Update failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, id });
}
