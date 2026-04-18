import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { META_REDIRECT_URI } from "@/lib/meta-oauth";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" }, 
      { status: 401 }
    );
  }

  const scope = [
    "ads_management",
    "ads_read", 
    "business_management",
    "pages_read_engagement"
  ].join(",");

  const metaAuthUrl = 
    `https://www.facebook.com/v19.0/` +
    `dialog/oauth` +
    `?client_id=${process.env.META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}` +
    `&scope=${scope}` +
    `&response_type=code` +
    `&state=${userId}`;

  redirect(metaAuthUrl);
}
