import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { listBriefCampaigns, tenantFor } from "@/modules/campaigns/repository";

type CampaignList = Awaited<ReturnType<typeof listBriefCampaigns>>;

/** List saved briefs, including drafts whose generation already used a credit. */
export async function GET() {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;

  try {
    // Saved briefs of this creator in their current workspace only.
    const tenant = await tenantFor(userId!);
    const campaigns: CampaignList = tenant ? await listBriefCampaigns(tenant) : [];
    return NextResponse.json({ campaigns }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Saved briefs are temporarily unavailable." }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
