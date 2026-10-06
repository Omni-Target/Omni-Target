import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { listUserBriefCampaigns } from "@/lib/db";

type CampaignList = Awaited<ReturnType<typeof listUserBriefCampaigns>>;

/** List saved briefs, including drafts whose generation already used a credit. */
export async function GET() {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;

  try {
    const campaigns: CampaignList = await listUserBriefCampaigns(userId!);
    return NextResponse.json({ campaigns }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Saved briefs are temporarily unavailable." }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
