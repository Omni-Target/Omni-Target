import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { listUserBriefCampaigns } from "@/lib/db";

type CampaignList = Awaited<ReturnType<typeof listUserBriefCampaigns>>;
const campaignsCache = new Map<string, { campaigns: CampaignList; timestamp: number }>();
const CAMPAIGNS_CACHE_TTL = 60_000; // 60 seconds

export function invalidateCampaignsCache(userId: string) {
  campaignsCache.delete(userId);
}

/**
 * List the signed-in user's finalized briefs, newest first — powers the
 * dashboard "Recent briefs" history panel.
 */
export async function GET() {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;

  const cached = campaignsCache.get(userId!);
  if (cached && Date.now() - cached.timestamp < CAMPAIGNS_CACHE_TTL) {
    return NextResponse.json({ campaigns: cached.campaigns });
  }

  const campaigns = await listUserBriefCampaigns(userId!);
  campaignsCache.set(userId!, { campaigns, timestamp: Date.now() });

  return NextResponse.json({ campaigns });
}
