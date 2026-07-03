import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api/require-user";
import { listUserBriefCampaigns } from "@/lib/db";

/**
 * List the signed-in user's finalized briefs, newest first — powers the
 * dashboard "Recent briefs" history panel.
 */
export async function GET() {
  const authResult = await requireUser();
  if (!authResult.ok) return authResult.response;
  const { userId } = authResult;

  const campaigns = await listUserBriefCampaigns(userId!);
  return NextResponse.json({ campaigns });
}
