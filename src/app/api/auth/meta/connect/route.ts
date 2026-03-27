import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json(
      { error: "Unauthorized" }, 
      { status: 401 }
    );
  }

  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID!,
    redirect_uri: 
      `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/meta/callback`,
    scope: [
      "ads_management",
      "ads_read", 
      "business_management",
      "pages_read_engagement"
    ].join(","),
    response_type: "code",
    state: userId,
    // state = userId for verification 
    // in callback
  });

  const metaAuthUrl = 
    `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;

  redirect(metaAuthUrl);
}
